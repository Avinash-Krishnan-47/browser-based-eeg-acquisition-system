"""
EEG Acquisition System - FastAPI Backend
National Institute of Technology, Tiruchirappalli
Department: Instrumentation and Control Engineering
Guide: Prof. V. Sridevi
Enhanced with Filtered/Unfiltered Signal Comparison, Export, and USB Live Streaming
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import numpy as np
from scipy import signal
import mne
import asyncio
import json
import os
import csv
from datetime import datetime
from pathlib import Path
import logging
import serial
import serial.tools.list_ports
import threading
import struct
import time

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Create FastAPI app
app = FastAPI(
    title="EEG Acquisition System",
    description="Browser-based EEG signal visualization with USB streaming and export",
    version="2.5.0"
)

app.mount("/static", StaticFiles(directory="."), name="static")

@app.get("/")
async def serve_index():
    return FileResponse("index.html") 

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
UPLOAD_FOLDER = Path("data/temp")
UPLOAD_FOLDER.mkdir(parents=True, exist_ok=True)

EXPORT_FOLDER = Path("data/exports")
EXPORT_FOLDER.mkdir(parents=True, exist_ok=True)

# Global state
class EEGState:
    def __init__(self):
        self.current_data = None
        self.is_streaming = False
        self.current_position = 0
        self.filter_bank = None
        self.active_filters = {
            'highpass': None,
            'lowpass': None,
            'notch': None
        }
        self.connected_clients = set()
        self.filtered_data_buffer = []
        self.original_data_buffer = []
        self.timestamps_buffer = []
        self.original_filename = None
        
        # USB Streaming
        self.usb_mode = False
        self.serial_connection = None
        self.usb_streaming_active = False
        self.usb_thread = None
        self.usb_sampling_rate = 250
        self.usb_n_channels = 8
    
    def reset(self):
        self.current_data = None
        self.is_streaming = False
        self.current_position = 0
        self.filtered_data_buffer = []
        self.original_data_buffer = []
        self.timestamps_buffer = []
        self.original_filename = None
        self.usb_mode = False
        self.stop_usb_streaming()

    def stop_usb_streaming(self):
        self.usb_streaming_active = False
        if self.serial_connection and self.serial_connection.is_open:
            try:
                self.serial_connection.close()
                logger.info("USB connection closed")
            except:
                pass
        self.serial_connection = None

state = EEGState()


class EEGFilterBank:
    """Signal processing for EEG data"""
    
    def __init__(self, sampling_rate: float):
        self.fs = sampling_rate
        logger.info(f"Initialized FilterBank with sampling rate: {sampling_rate} Hz")
    
    def design_highpass(self, cutoff_freq: float, order: int = 4):
        """Design high-pass Butterworth filter"""
        try:
            nyquist = self.fs / 2
            normalized_cutoff = cutoff_freq / nyquist
            
            if normalized_cutoff <= 0 or normalized_cutoff >= 1:
                logger.warning(f"Invalid highpass cutoff: {cutoff_freq} Hz")
                return None
            
            b, a = signal.butter(order, normalized_cutoff, btype='high')
            logger.info(f"Designed highpass filter: {cutoff_freq} Hz")
            return (b, a)
        except Exception as e:
            logger.error(f"Error designing highpass filter: {e}")
            return None
    
    def design_lowpass(self, cutoff_freq: float, order: int = 4):
        """Design low-pass Butterworth filter"""
        try:
            nyquist = self.fs / 2
            normalized_cutoff = cutoff_freq / nyquist
            
            if normalized_cutoff <= 0 or normalized_cutoff >= 1:
                logger.warning(f"Invalid lowpass cutoff: {cutoff_freq} Hz")
                return None
            
            b, a = signal.butter(order, normalized_cutoff, btype='low')
            logger.info(f"Designed lowpass filter: {cutoff_freq} Hz")
            return (b, a)
        except Exception as e:
            logger.error(f"Error designing lowpass filter: {e}")
            return None
    
    def design_notch(self, notch_freq: float = 50.0, quality_factor: float = 30.0):
        """Design notch filter for power line interference"""
        try:
            b, a = signal.iirnotch(notch_freq, quality_factor, self.fs)
            logger.info(f"Designed notch filter: {notch_freq} Hz (Q={quality_factor})")
            return (b, a)
        except Exception as e:
            logger.error(f"Error designing notch filter: {e}")
            return None
    
    def apply_filter(self, data: np.ndarray, filter_coeffs):
        """Apply filter using zero-phase filtering"""
        if filter_coeffs is None:
            return data
        
        try:
            b, a = filter_coeffs
            filtered_data = np.zeros_like(data)
            
            for i in range(data.shape[0]):
                filtered_data[i, :] = signal.filtfilt(b, a, data[i, :])
            
            return filtered_data
        except Exception as e:
            logger.error(f"Error applying filter: {e}")
            return data


def load_edf_file(filepath: Path) -> dict:
    """Load and parse EDF file"""
    try:
        logger.info(f"Loading EDF file: {filepath}")
        raw = mne.io.read_raw_edf(str(filepath), preload=True, verbose=False)
        
        sfreq = raw.info['sfreq']
        channel_names = raw.ch_names
        data = raw.get_data()
        
        # Convert to microvolts
        data = data * 1e6
        
        result = {
            'data': data,
            'sfreq': float(sfreq),
            'channel_names': channel_names,
            'n_channels': len(channel_names),
            'duration': float(data.shape[1] / sfreq),
            'n_samples': int(data.shape[1])
        }
        
        logger.info(f"Successfully loaded EDF: {len(channel_names)} channels, "
                   f"{result['duration']:.2f}s duration, {sfreq} Hz")
        return result
        
    except Exception as e:
        logger.error(f"Error loading EDF file: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to load EDF file: {str(e)}")


def apply_all_filters(data: np.ndarray) -> np.ndarray:
    """Apply all active filters to data"""
    if state.filter_bank is None:
        return data
    
    filtered_data = data.copy()
    
    # Apply in order: highpass -> lowpass -> notch
    if state.active_filters['highpass'] is not None:
        filtered_data = state.filter_bank.apply_filter(
            filtered_data, state.active_filters['highpass']
        )
    
    if state.active_filters['lowpass'] is not None:
        filtered_data = state.filter_bank.apply_filter(
            filtered_data, state.active_filters['lowpass']
        )
    
    if state.active_filters['notch'] is not None:
        filtered_data = state.filter_bank.apply_filter(
            filtered_data, state.active_filters['notch']
        )
    
    return filtered_data


def parse_eeg_packet(raw_data: bytes, n_channels: int = 8) -> np.ndarray:
    """Parse raw serial data packet to EEG samples (16-bit big-endian)"""
    try:
        bytes_per_sample = n_channels * 2
        
        if len(raw_data) < bytes_per_sample:
            return None
        
        samples = []
        for i in range(n_channels):
            idx = i * 2
            value = struct.unpack('>h', raw_data[idx:idx+2])[0]
            # Convert to microvolts (adjust scaling based on hardware)
            samples.append(value * 0.0000507 * 1e6)
        
        return np.array(samples)
        
    except Exception as e:
        logger.error(f"Error parsing EEG packet: {e}")
        return None


def usb_read_thread(websocket: WebSocket):
    """Background thread to read USB data continuously"""
    logger.info("USB read thread started")
    chunk_buffer = []
    chunk_size = int(state.usb_sampling_rate * 0.5)
    sample_count = 0
    start_time = time.time()
    
    try:
        while state.usb_streaming_active:
            if state.serial_connection and state.serial_connection.in_waiting:
                bytes_per_sample = state.usb_n_channels * 2
                raw_data = state.serial_connection.read(bytes_per_sample)
                
                samples = parse_eeg_packet(raw_data, state.usb_n_channels)
                
                if samples is not None:
                    chunk_buffer.append(samples)
                    sample_count += 1
                    
                    if len(chunk_buffer) >= chunk_size:
                        chunk = np.array(chunk_buffer).T
                        filtered_chunk = apply_all_filters(chunk)
                        current_time = time.time() - start_time
                        
                        state.original_data_buffer.append(chunk)
                        state.filtered_data_buffer.append(filtered_chunk)
                        state.timestamps_buffer.append(current_time)
                        
                        asyncio.run(send_usb_data_chunk(websocket, chunk, filtered_chunk, current_time))
                        chunk_buffer = []
            else:
                time.sleep(0.001)
                
    except Exception as e:
        logger.error(f"Error in USB read thread: {e}")
    finally:
        logger.info("USB read thread stopped")


async def send_usb_data_chunk(websocket: WebSocket, original: np.ndarray, filtered: np.ndarray, timestamp: float):
    """Send USB data chunk via WebSocket"""
    try:
        await websocket.send_json({
            "type": "eeg_data",
            "data": {
                "original": original.tolist(),
                "filtered": filtered.tolist(),
                "timestamp": timestamp,
                "sample_index": int(timestamp * state.usb_sampling_rate)
            }
        })
    except Exception as e:
        logger.error(f"Error sending USB data: {e}")


async def stream_eeg_data(websocket: WebSocket, chunk_duration: float = 0.5):
    """Stream EEG data through WebSocket - FILE MODE"""
    if state.current_data is None:
        await websocket.send_json({
            "type": "error",
            "message": "No EDF file loaded"
        })
        return
    
    data = state.current_data['data']
    sfreq = state.current_data['sfreq']
    chunk_size = int(chunk_duration * sfreq)
    n_samples = data.shape[1]
    
    state.current_position = 0
    state.is_streaming = True
    
    state.filtered_data_buffer = []
    state.original_data_buffer = []
    state.timestamps_buffer = []
    
    logger.info("Starting EEG data stream (FILE MODE)")
    
    try:
        while state.is_streaming and state.current_position < n_samples:
            end_position = min(state.current_position + chunk_size, n_samples)
            chunk = data[:, state.current_position:end_position]
            
            filtered_chunk = apply_all_filters(chunk)
            current_time = state.current_position / sfreq
            
            state.original_data_buffer.append(chunk)
            state.filtered_data_buffer.append(filtered_chunk)
            state.timestamps_buffer.append(current_time)
            
            await websocket.send_json({
                "type": "eeg_data",
                "data": {
                    "original": chunk.tolist(),
                    "filtered": filtered_chunk.tolist(),
                    "timestamp": current_time,
                    "sample_index": state.current_position
                }
            })
            
            state.current_position = end_position
            await asyncio.sleep(chunk_duration)
        
        state.is_streaming = False
        await websocket.send_json({
            "type": "stream_status",
            "status": "stopped"
        })
        logger.info("EEG data stream completed (FILE MODE)")
        
    except Exception as e:
        logger.error(f"Error during streaming: {e}")
        state.is_streaming = False


def save_filtered_data_csv(filepath: Path):
    """Save filtered data to CSV file"""
    try:
        if not state.filtered_data_buffer:
            raise ValueError("No filtered data available")
        
        filtered_data = np.hstack(state.filtered_data_buffer)
        original_data = np.hstack(state.original_data_buffer)
        
        n_channels, n_samples = filtered_data.shape
        
        if state.usb_mode:
            sfreq = state.usb_sampling_rate
            channel_names = [f"CH{i+1}" for i in range(state.usb_n_channels)]
        else:
            sfreq = state.current_data['sfreq']
            channel_names = state.current_data['channel_names']
        
        timestamps = np.arange(n_samples) / sfreq
        
        with open(filepath, 'w', newline='') as csvfile:
            writer = csv.writer(csvfile)
            
            header = ['Time (s)']
            for ch_name in channel_names:
                header.append(f'{ch_name}_Original')
                header.append(f'{ch_name}_Filtered')
            writer.writerow(header)
            
            for i in range(n_samples):
                row = [timestamps[i]]
                for ch in range(n_channels):
                    row.append(original_data[ch, i])
                    row.append(filtered_data[ch, i])
                writer.writerow(row)
        
        logger.info(f"Saved filtered data to CSV: {filepath}")
        return True
        
    except Exception as e:
        logger.error(f"Error saving CSV: {e}")
        return False


def save_filtered_data_edf(filepath: Path):
    """Save filtered data to EDF file"""
    try:
        if not state.filtered_data_buffer:
            raise ValueError("No filtered data available")
        
        filtered_data = np.hstack(state.filtered_data_buffer)
        filtered_data_volts = filtered_data * 1e-6
        
        if state.usb_mode:
            sfreq = state.usb_sampling_rate
            channel_names = [f"CH{i+1}" for i in range(state.usb_n_channels)]
        else:
            sfreq = state.current_data['sfreq']
            channel_names = state.current_data['channel_names']
        
        info = mne.create_info(
            ch_names=channel_names,
            sfreq=sfreq,
            ch_types='eeg'
        )
        
        raw = mne.io.RawArray(filtered_data_volts, info)
        raw.export(str(filepath), overwrite=True)
        
        logger.info(f"Saved filtered data to EDF: {filepath}")
        return True
        
    except Exception as e:
        logger.error(f"Error saving EDF: {e}")
        return False


# ===== API ENDPOINTS =====

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "version": "2.5.0",
        "streaming": state.is_streaming,
        "data_loaded": state.current_data is not None,
        "has_filtered_data": len(state.filtered_data_buffer) > 0,
        "usb_mode": state.usb_mode,
        "usb_active": state.usb_streaming_active
    }


@app.get("/api/serial-ports")
async def list_serial_ports():
    """List available serial ports"""
    try:
        ports = serial.tools.list_ports.comports()
        port_list = [
            {
                "device": port.device,
                "description": port.description,
                "hwid": port.hwid
            }
            for port in ports
        ]
        logger.info(f"Found {len(port_list)} serial ports")
        return {"ports": port_list}
    except Exception as e:
        logger.error(f"Error listing serial ports: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/usb/connect")
async def connect_usb(port: str, baudrate: int = 115200, n_channels: int = 8, sampling_rate: int = 250):
    """Connect to USB/Serial EEG device"""
    try:
        state.stop_usb_streaming()
        state.is_streaming = False
        
        state.filtered_data_buffer = []
        state.original_data_buffer = []
        state.timestamps_buffer = []
        
        state.serial_connection = serial.Serial(
            port=port,
            baudrate=baudrate,
            timeout=1,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE
        )
        
        state.usb_mode = True
        state.usb_sampling_rate = sampling_rate
        state.usb_n_channels = n_channels
        state.original_filename = f"usb_{port.replace('/', '_')}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        
        state.filter_bank = EEGFilterBank(sampling_rate)
        state.active_filters = {
            'highpass': None,
            'lowpass': None,
            'notch': None
        }
        
        logger.info(f"USB connected: {port} @ {baudrate} baud, {n_channels} channels, {sampling_rate} Hz")
        
        return {
            "success": True,
            "port": port,
            "baudrate": baudrate,
            "n_channels": n_channels,
            "sampling_rate": sampling_rate,
            "message": "USB device connected successfully"
        }
        
    except serial.SerialException as e:
        logger.error(f"Serial connection error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to connect: {str(e)}")
    except Exception as e:
        logger.error(f"USB connection error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/usb/disconnect")
async def disconnect_usb():
    """Disconnect USB device"""
    try:
        state.stop_usb_streaming()
        state.usb_mode = False
        logger.info("USB device disconnected")
        return {"success": True, "message": "USB device disconnected"}
    except Exception as e:
        logger.error(f"Error disconnecting USB: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload and process EDF file"""
    try:
        if not file.filename.endswith('.edf'):
            raise HTTPException(status_code=400, detail="Only .edf files are supported")
        
        state.stop_usb_streaming()
        state.is_streaming = False
        await asyncio.sleep(0.6)
        
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"eeg_data_{timestamp}.edf"
        filepath = UPLOAD_FOLDER / filename
        
        with open(filepath, "wb") as f:
            content = await file.read()
            f.write(content)
        
        logger.info(f"Saved uploaded file: {filename}")
        
        state.current_data = load_edf_file(filepath)
        state.original_filename = file.filename
        state.usb_mode = False
        
        state.filter_bank = EEGFilterBank(state.current_data['sfreq'])
        
        state.active_filters = {
            'highpass': None,
            'lowpass': None,
            'notch': None
        }
        state.current_position = 0
        state.filtered_data_buffer = []
        state.original_data_buffer = []
        state.timestamps_buffer = []
        
        return {
            "success": True,
            "filename": filename,
            "original_filename": file.filename,
            "channels": state.current_data['channel_names'],
            "sampling_rate": state.current_data['sfreq'],
            "duration": state.current_data['duration'],
            "n_channels": state.current_data['n_channels'],
            "n_samples": state.current_data['n_samples']
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Upload error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/export")
async def export_filtered_data(format: str = "csv"):
    """Export filtered data to file"""
    try:
        if not state.filtered_data_buffer:
            raise HTTPException(status_code=400, detail="No filtered data available. Please stream data first.")
        
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        
        if state.usb_mode:
            base_name = f"usb_recording_{timestamp}"
        else:
            base_name = state.original_filename.replace('.edf', '') if state.original_filename else 'eeg_filtered'
        
        if format.lower() == "csv":
            filename = f"{base_name}_filtered_{timestamp}.csv"
            filepath = EXPORT_FOLDER / filename
            success = save_filtered_data_csv(filepath)
        elif format.lower() == "edf":
            filename = f"{base_name}_filtered_{timestamp}.edf"
            filepath = EXPORT_FOLDER / filename
            success = save_filtered_data_edf(filepath)
        else:
            raise HTTPException(status_code=400, detail="Invalid format. Use 'csv' or 'edf'")
        
        if success:
            return {
                "success": True,
                "filename": filename,
                "filepath": str(filepath),
                "format": format,
                "samples_exported": sum(chunk.shape[1] for chunk in state.filtered_data_buffer)
            }
        else:
            raise HTTPException(status_code=500, detail="Failed to export data")
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Export error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/exports")
async def list_exports():
    """List all exported files"""
    try:
        exports = []
        for file in EXPORT_FOLDER.glob("*"):
            if file.is_file():
                exports.append({
                    "filename": file.name,
                    "size": file.stat().st_size,
                    "created": datetime.fromtimestamp(file.stat().st_ctime).isoformat()
                })
        return {"exports": exports}
    except Exception as e:
        logger.error(f"Error listing exports: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/download/{filename}")
async def download_export(filename: str):
    """Download an exported file"""
    filepath = EXPORT_FOLDER / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(filepath, filename=filename)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time communication"""
    await websocket.accept()
    state.connected_clients.add(websocket)
    logger.info("WebSocket client connected")
    
    try:
        await websocket.send_json({
            "type": "connection",
            "status": "connected"
        })
        
        while True:
            message = await websocket.receive_text()
            data = json.loads(message)
            
            message_type = data.get("type")
            
            if message_type == "start_stream":
                if state.usb_mode:
                    if not state.serial_connection or not state.serial_connection.is_open:
                        await websocket.send_json({
                            "type": "error",
                            "message": "USB device not connected"
                        })
                        continue
                    
                    state.usb_streaming_active = True
                    state.is_streaming = True
                    
                    state.filtered_data_buffer = []
                    state.original_data_buffer = []
                    state.timestamps_buffer = []
                    
                    await websocket.send_json({
                        "type": "stream_status",
                        "status": "started",
                        "mode": "usb"
                    })
                    
                    state.usb_thread = threading.Thread(target=usb_read_thread, args=(websocket,))
                    state.usb_thread.daemon = True
                    state.usb_thread.start()
                    
                    logger.info("USB streaming started")
                
                else:
                    if state.current_data is None:
                        await websocket.send_json({
                            "type": "error",
                            "message": "No EDF file loaded"
                        })
                        continue
                    
                    await websocket.send_json({
                        "type": "stream_status",
                        "status": "started",
                        "mode": "file"
                    })
                    
                    asyncio.create_task(stream_eeg_data(websocket))
            
            elif message_type == "stop_stream":
                state.is_streaming = False
                state.usb_streaming_active = False
                await websocket.send_json({
                    "type": "stream_status",
                    "status": "stopped"
                })
            
            elif message_type == "pause_stream":
                state.is_streaming = False
                state.usb_streaming_active = False
                await websocket.send_json({
                    "type": "stream_status",
                    "status": "paused"
                })
            
            elif message_type == "resume_stream":
                if state.usb_mode:
                    if not state.serial_connection or not state.serial_connection.is_open:
                        await websocket.send_json({
                            "type": "error",
                            "message": "USB device not connected"
                        })
                        continue
                    
                    state.usb_streaming_active = True
                    state.is_streaming = True
                    
                    await websocket.send_json({
                        "type": "stream_status",
                        "status": "started",
                        "mode": "usb"
                    })
                    
                    state.usb_thread = threading.Thread(target=usb_read_thread, args=(websocket,))
                    state.usb_thread.daemon = True
                    state.usb_thread.start()
                else:
                    if state.current_data is None:
                        await websocket.send_json({
                            "type": "error",
                            "message": "No EDF file loaded"
                        })
                        continue
                    
                    state.is_streaming = True
                    await websocket.send_json({
                        "type": "stream_status",
                        "status": "started",
                        "mode": "file"
                    })
                    
                    asyncio.create_task(stream_eeg_data(websocket))
            
            elif message_type == "update_filter":
                await handle_filter_update(websocket, data)
            
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
        state.connected_clients.discard(websocket)
        state.is_streaming = False
        state.usb_streaming_active = False
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        state.connected_clients.discard(websocket)


async def handle_filter_update(websocket: WebSocket, data: dict):
    """Handle filter update requests"""
    if state.filter_bank is None:
        await websocket.send_json({
            "type": "error",
            "message": "No data source configured"
        })
        return
    
    filter_type = data.get("filter_type")
    
    try:
        if filter_type == "highpass":
            cutoff = float(data.get("cutoff", 0))
            if cutoff > 0:
                state.active_filters['highpass'] = state.filter_bank.design_highpass(cutoff)
                await websocket.send_json({
                    "type": "filter_status",
                    "filter": "highpass",
                    "status": "applied",
                    "cutoff": cutoff
                })
            else:
                state.active_filters['highpass'] = None
                await websocket.send_json({
                    "type": "filter_status",
                    "filter": "highpass",
                    "status": "removed"
                })
        
        elif filter_type == "lowpass":
            cutoff = float(data.get("cutoff", 0))
            if cutoff > 0:
                state.active_filters['lowpass'] = state.filter_bank.design_lowpass(cutoff)
                await websocket.send_json({
                    "type": "filter_status",
                    "filter": "lowpass",
                    "status": "applied",
                    "cutoff": cutoff
                })
            else:
                state.active_filters['lowpass'] = None
                await websocket.send_json({
                    "type": "filter_status",
                    "filter": "lowpass",
                    "status": "removed"
                })
        
        elif filter_type == "notch":
            notch_freq = float(data.get("notch_freq", 50))
            enabled = data.get("enabled", True)
            
            if enabled:
                state.active_filters['notch'] = state.filter_bank.design_notch(notch_freq)
                await websocket.send_json({
                    "type": "filter_status",
                    "filter": "notch",
                    "status": "applied",
                    "frequency": notch_freq
                })
            else:
                state.active_filters['notch'] = None
                await websocket.send_json({
                    "type": "filter_status",
                    "filter": "notch",
                    "status": "removed"
                })
    
    except Exception as e:
        logger.error(f"Filter update error: {e}")
        await websocket.send_json({
            "type": "error",
            "message": f"Filter error: {str(e)}"
        })


if __name__ == "__main__":
    import uvicorn
    
    print("=" * 70)
    print("EEG Acquisition System - FastAPI Backend v2.5")
    print("With USB Live Streaming Support")
    print("=" * 70)
    print(f"Server: http://localhost:8000")
    print(f"Docs: http://localhost:8000/docs")
    print("=" * 70)
    
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"
    )
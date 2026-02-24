"""
EEG Acquisition System - FastAPI Backend
National Institute of Technology, Tiruchirappalli
Department: Instrumentation and Control Engineering
Guide: Prof. V. Sridevi
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
from datetime import datetime
from pathlib import Path
import logging
from fastapi.staticfiles import StaticFiles

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Create FastAPI app
app = FastAPI(
    title="EEG Acquisition System",
    description="Browser-based EEG signal visualization and processing",
    version="2.0.0"
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
    
    def reset(self):
        self.current_data = None
        self.is_streaming = False
        self.current_position = 0

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


async def stream_eeg_data(websocket: WebSocket, chunk_duration: float = 0.5):
    """Stream EEG data through WebSocket"""
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
    
    logger.info("Starting EEG data stream")
    
    try:
        while state.is_streaming and state.current_position < n_samples:
            # Get chunk
            end_position = min(state.current_position + chunk_size, n_samples)
            chunk = data[:, state.current_position:end_position]
            
            # Apply filters
            filtered_chunk = apply_all_filters(chunk)
            
            # Calculate timestamp
            current_time = state.current_position / sfreq
            
            # Send data
            await websocket.send_json({
                "type": "eeg_data",
                "data": {
                    "channels": filtered_chunk.tolist(),
                    "timestamp": current_time,
                    "sample_index": state.current_position
                }
            })
            
            state.current_position = end_position
            
            # Simulate real-time streaming
            await asyncio.sleep(chunk_duration)
        
        # Stream finished
        state.is_streaming = False
        await websocket.send_json({
            "type": "stream_status",
            "status": "stopped"
        })
        logger.info("EEG data stream completed")
        
    except Exception as e:
        logger.error(f"Error during streaming: {e}")
        state.is_streaming = False


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "version": "2.0.0",
        "streaming": state.is_streaming,
        "data_loaded": state.current_data is not None
    }


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload and process EDF file"""
    try:
        # Validate file
        if not file.filename.endswith('.edf'):
            raise HTTPException(status_code=400, detail="Only .edf files are supported")
        
        # Stop any ongoing streaming
        state.is_streaming = False
        await asyncio.sleep(0.6)
        
        # Save file
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"eeg_data_{timestamp}.edf"
        filepath = UPLOAD_FOLDER / filename
        
        with open(filepath, "wb") as f:
            content = await file.read()
            f.write(content)
        
        logger.info(f"Saved uploaded file: {filename}")
        
        # Load and parse
        state.current_data = load_edf_file(filepath)
        
        # Initialize filter bank
        state.filter_bank = EEGFilterBank(state.current_data['sfreq'])
        
        # Reset filters and position
        state.active_filters = {
            'highpass': None,
            'lowpass': None,
            'notch': None
        }
        state.current_position = 0
        
        return {
            "success": True,
            "filename": filename,
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


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time communication"""
    await websocket.accept()
    state.connected_clients.add(websocket)
    logger.info("WebSocket client connected")
    
    try:
        # Send connection confirmation
        await websocket.send_json({
            "type": "connection",
            "status": "connected"
        })
        
        while True:
            # Receive message
            message = await websocket.receive_text()
            data = json.loads(message)
            
            message_type = data.get("type")
            
            if message_type == "start_stream":
                if state.current_data is None:
                    await websocket.send_json({
                        "type": "error",
                        "message": "No EDF file loaded"
                    })
                    continue
                
                await websocket.send_json({
                    "type": "stream_status",
                    "status": "started"
                })
                
                # Start streaming in background
                asyncio.create_task(stream_eeg_data(websocket))
            
            elif message_type == "stop_stream":
                state.is_streaming = False
                await websocket.send_json({
                    "type": "stream_status",
                    "status": "stopped"
                })
            
            elif message_type == "pause_stream":
                state.is_streaming = False
                await websocket.send_json({
                    "type": "stream_status",
                    "status": "paused"
                })
            
            elif message_type == "resume_stream":
                if state.current_data is None:
                    await websocket.send_json({
                        "type": "error",
                        "message": "No EDF file loaded"
                    })
                    continue
                
                state.is_streaming = True
                await websocket.send_json({
                    "type": "stream_status",
                    "status": "started"
                })
                
                asyncio.create_task(stream_eeg_data(websocket))
            
            elif message_type == "update_filter":
                await handle_filter_update(websocket, data)
            
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
        state.connected_clients.discard(websocket)
        state.is_streaming = False
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        state.connected_clients.discard(websocket)


async def handle_filter_update(websocket: WebSocket, data: dict):
    """Handle filter update requests"""
    if state.filter_bank is None:
        await websocket.send_json({
            "type": "error",
            "message": "No EDF file loaded"
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
    
    print("=" * 60)
    print("EEG Acquisition System - FastAPI Backend")
    print("=" * 60)
    print(f"Server starting on: http://localhost:8000")
    print(f"API Documentation: http://localhost:8000/docs")
    print(f"Health Check: http://localhost:8000/health")
    print("=" * 60)
    
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"
    )
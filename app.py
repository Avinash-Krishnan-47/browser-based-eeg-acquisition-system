"""
EEG Acquisition System - FastAPI Backend
National Institute of Technology, Tiruchirappalli
Department: Instrumentation and Control Engineering
Guide: Prof. V. Sridevi

Architecture:
  FILE MODE : Browser uploads EDF → Python streams chunks directly via WebSocket (no Firebase)
  USB MODE  : USB Device → Python (serial) → Firebase RTDB → Browser (Firebase SDK)
              Browser ↔ WebSocket (control commands: start/stop/filters)
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException
from fastapi.responses import FileResponse
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

# Firebase Admin SDK
import firebase_admin
from firebase_admin import credentials, db as firebase_db

# ─── Logging ────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ─── Firebase Initialisation (USB mode only) ─────────────────────────────────
FIREBASE_CREDENTIALS_PATH = "firebase-credentials.json"
FIREBASE_DATABASE_URL = "https://eeg-fyp-default-rtdb.asia-southeast1.firebasedatabase.app/"

def init_firebase():
    if not firebase_admin._apps:
        if not Path(FIREBASE_CREDENTIALS_PATH).exists():
            logger.warning(
                f"Firebase credentials not found: {FIREBASE_CREDENTIALS_PATH}. "
                "USB streaming via Firebase will be disabled."
            )
            return False
        try:
            cred = credentials.Certificate(FIREBASE_CREDENTIALS_PATH)
            firebase_admin.initialize_app(cred, {"databaseURL": FIREBASE_DATABASE_URL})
            logger.info("Firebase Admin SDK initialised (USB mode only).")
            return True
        except Exception as e:
            logger.error(f"Firebase init failed: {e}")
            return False
    return True

FIREBASE_ENABLED = init_firebase()


def firebase_write(path: str, data: dict):
    """Write to Firebase RTDB. Used ONLY for USB streaming."""
    if not FIREBASE_ENABLED:
        return
    try:
        firebase_db.reference(path).set(data)
    except Exception as e:
        logger.error(f"Firebase write error at '{path}': {e}")


def firebase_update(path: str, data: dict):
    if not FIREBASE_ENABLED:
        return
    try:
        firebase_db.reference(path).update(data)
    except Exception as e:
        logger.error(f"Firebase update error at '{path}': {e}")


# ─── FastAPI App ─────────────────────────────────────────────────────────────
app = FastAPI(
    title="EEG Acquisition System",
    description="EEG signal acquisition — File mode: WebSocket direct | USB mode: Firebase RTDB",
    version="4.2.0",
)

app.mount("/static", StaticFiles(directory="."), name="static")

@app.get("/")
async def serve_index():
    return FileResponse("index.html")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_FOLDER = Path("data/temp")
UPLOAD_FOLDER.mkdir(parents=True, exist_ok=True)

EXPORT_FOLDER = Path("data/exports")
EXPORT_FOLDER.mkdir(parents=True, exist_ok=True)


# ─── Global State ────────────────────────────────────────────────────────────
class EEGState:
    def __init__(self):
        self.current_data = None
        self.is_streaming = False
        self.current_position = 0
        self.filter_bank = None
        self.active_filters = {"highpass": None, "lowpass": None, "notch": None}
        self.filter_types = {"highpass": "butterworth", "lowpass": "butterworth"}
        self.connected_clients: set[WebSocket] = set()

        self.filtered_data_buffer = []
        self.original_data_buffer = []
        self.timestamps_buffer = []
        self.original_filename = None

        # USB streaming
        self.usb_mode = False
        self.serial_connection = None
        self.usb_streaming_active = False
        self.usb_thread = None
        self.usb_sampling_rate = 250
        self.usb_n_channels = 8

        self._chunk_index = 0
        self.pause_position = 0
        self.is_paused = False

    def reset(self):
        self.current_data = None
        self.is_streaming = False
        self.current_position = 0
        self.pause_position = 0
        self.is_paused = False
        self.filtered_data_buffer = []
        self.original_data_buffer = []
        self.timestamps_buffer = []
        self.original_filename = None
        self.usb_mode = False
        self._chunk_index = 0
        self.stop_usb_streaming()

    def stop_usb_streaming(self):
        self.usb_streaming_active = False
        if self.serial_connection and self.serial_connection.is_open:
            try:
                self.serial_connection.close()
                logger.info("USB serial connection closed.")
            except Exception:
                pass
        self.serial_connection = None

    def next_chunk_index(self) -> int:
        idx = self._chunk_index
        self._chunk_index += 1
        return idx


state = EEGState()


# ─── Filter Bank ─────────────────────────────────────────────────────────────
class EEGFilterBank:
    def __init__(self, sampling_rate: float):
        self.fs = sampling_rate

    def _normalise(self, cutoff: float) -> float:
        return cutoff / (self.fs / 2)

    def design_highpass(self, cutoff_freq: float, order: int = 4, filter_type: str = "butterworth"):
        n = self._normalise(cutoff_freq)
        if not (0 < n < 1):
            return None
        try:
            if filter_type == "butterworth":
                b, a = signal.butter(order, n, btype="high")
            elif filter_type == "chebyshev1":
                b, a = signal.cheby1(order, 0.5, n, btype="high")
            elif filter_type == "chebyshev2":
                b, a = signal.cheby2(order, 40, n, btype="high")
            elif filter_type == "elliptic":
                b, a = signal.ellip(order, 0.5, 40, n, btype="high")
            else:
                b, a = signal.butter(order, n, btype="high")
            return (b, a, filter_type)
        except Exception as e:
            logger.error(f"Highpass design error: {e}")
            return None

    def design_lowpass(self, cutoff_freq: float, order: int = 4, filter_type: str = "butterworth"):
        n = self._normalise(cutoff_freq)
        if not (0 < n < 1):
            return None
        try:
            if filter_type == "butterworth":
                b, a = signal.butter(order, n, btype="low")
            elif filter_type == "chebyshev1":
                b, a = signal.cheby1(order, 0.5, n, btype="low")
            elif filter_type == "chebyshev2":
                b, a = signal.cheby2(order, 40, n, btype="low")
            elif filter_type == "elliptic":
                b, a = signal.ellip(order, 0.5, 40, n, btype="low")
            else:
                b, a = signal.butter(order, n, btype="low")
            return (b, a, filter_type)
        except Exception as e:
            logger.error(f"Lowpass design error: {e}")
            return None

    def design_notch(self, notch_freq: float = 50.0, q: float = 30.0):
        try:
            b, a = signal.iirnotch(notch_freq, q, self.fs)
            return (b, a, "notch")
        except Exception as e:
            logger.error(f"Notch design error: {e}")
            return None

    def apply_filter(self, data: np.ndarray, coeffs) -> np.ndarray:
        if coeffs is None:
            return data
        b, a = coeffs[0], coeffs[1]
        out = np.zeros_like(data)
        for i in range(data.shape[0]):
            out[i] = signal.filtfilt(b, a, data[i])
        return out


def apply_all_filters(data: np.ndarray) -> np.ndarray:
    if state.filter_bank is None:
        return data
    d = data.copy()
    for key in ("highpass", "lowpass", "notch"):
        if state.active_filters[key] is not None:
            d = state.filter_bank.apply_filter(d, state.active_filters[key])
    return d


# ─── NEW: Re-filter entire original buffer and return as filtered chunks ──────
def refilter_original_buffer() -> list:
    """
    Re-applies current active_filters to every chunk in original_data_buffer.
    Returns a new list of filtered chunks matching the original buffer layout.
    Called server-side whenever filters change mid-stream so the frontend
    can request a full buffer refresh via the 'refilter_buffer' WS message.
    """
    if not state.original_data_buffer:
        return []
    result = []
    for chunk in state.original_data_buffer:
        result.append(apply_all_filters(chunk))
    return result


# ─── Firebase Writers (USB mode only) ────────────────────────────────────────
def write_chunk_to_firebase(
    original: np.ndarray,
    filtered: np.ndarray,
    timestamp: float,
    channel_names: list,
):
    if not FIREBASE_ENABLED:
        return
    chunk_data = {
        "timestamp": round(timestamp, 4),
        "mode": "usb",
        "channel_names": channel_names,
        "sampling_rate": state.usb_sampling_rate,
        "original": [[round(float(v), 4) for v in ch] for ch in original.tolist()],
        "filtered": [[round(float(v), 4) for v in ch] for ch in filtered.tolist()],
        "updated_at": int(time.time() * 1000),
    }
    firebase_write("eeg/stream/latest", chunk_data)


def write_status_to_firebase(status: str, extra: dict | None = None):
    payload = {"status": status, "updated_at": int(time.time() * 1000)}
    if extra:
        payload.update(extra)
    firebase_update("eeg/stream/status", payload)


def write_session_config_to_firebase(channel_names: list, sampling_rate: float):
    firebase_write("eeg/session", {
        "channel_names": channel_names,
        "sampling_rate": sampling_rate,
        "mode": "usb",
        "started_at": int(time.time() * 1000),
    })


# ─── EDF Loader ──────────────────────────────────────────────────────────────
def load_edf_file(filepath: Path) -> dict:
    try:
        raw = mne.io.read_raw_edf(str(filepath), preload=True, verbose=False)
        data = raw.get_data() * 1e6  # → μV
        return {
            "data": data,
            "sfreq": float(raw.info["sfreq"]),
            "channel_names": raw.ch_names,
            "n_channels": len(raw.ch_names),
            "duration": float(data.shape[1] / raw.info["sfreq"]),
            "n_samples": int(data.shape[1]),
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to load EDF: {e}")


# ─── USB Packet Parser ────────────────────────────────────────────────────────
def parse_eeg_packet(raw_bytes: bytes, n_channels: int = 8):
    try:
        if len(raw_bytes) < n_channels * 2:
            return None
        samples = []
        for i in range(n_channels):
            val = struct.unpack(">h", raw_bytes[i * 2: i * 2 + 2])[0]
            samples.append(val * 0.0000507 * 1e6)
        return np.array(samples)
    except Exception as e:
        logger.error(f"Packet parse error: {e}")
        return None


# ─── USB Read Thread (Firebase path) ─────────────────────────────────────────
def usb_read_thread(websocket: WebSocket, loop: asyncio.AbstractEventLoop):
    logger.info("USB read thread started → Firebase path.")
    chunk_buffer = []
    chunk_size = max(1, int(state.usb_sampling_rate * 0.5))
    start_time = time.time()
    channel_names = [f"CH{i+1}" for i in range(state.usb_n_channels)]

    write_session_config_to_firebase(channel_names, state.usb_sampling_rate)

    try:
        while state.usb_streaming_active:
            conn = state.serial_connection
            if conn and conn.is_open and conn.in_waiting:
                raw = conn.read(state.usb_n_channels * 2)
                sample = parse_eeg_packet(raw, state.usb_n_channels)
                if sample is not None:
                    chunk_buffer.append(sample)

                    if len(chunk_buffer) >= chunk_size:
                        chunk = np.array(chunk_buffer).T
                        filtered = apply_all_filters(chunk)
                        ts = time.time() - start_time

                        state.original_data_buffer.append(chunk)
                        state.filtered_data_buffer.append(filtered)
                        state.timestamps_buffer.append(ts)

                        write_chunk_to_firebase(chunk, filtered, ts, channel_names)

                        notify = json.dumps({
                            "type": "firebase_chunk_ready",
                            "timestamp": round(ts, 4),
                        })
                        if state.usb_streaming_active:
                            try:
                                asyncio.run_coroutine_threadsafe(
                                    websocket.send_text(notify), loop
                                )
                            except Exception as e:
                                logger.warning("WebSocket closed during USB stream")
                                state.usb_streaming_active = False

                        chunk_buffer = []
            else:
                time.sleep(0.001)

    except Exception as e:
        logger.error(f"USB read thread error: {e}")
    finally:
        write_status_to_firebase("stopped")
        logger.info("USB read thread stopped.")


# ─── File Streaming Coroutine ─────────────────────────────────────────────────
async def stream_eeg_file(websocket, chunk_duration: float = 0.5, resume: bool = False):
    if state.current_data is None:
        await websocket.send_json({"type": "error", "message": "No EDF file loaded."})
        return

    data          = state.current_data["data"]
    sfreq         = state.current_data["sfreq"]
    channel_names = state.current_data["channel_names"]
    chunk_size    = int(chunk_duration * sfreq)
    n_samples     = data.shape[1]

    if resume and state.is_paused:
        state.current_position = state.pause_position
        state.is_paused = False
    else:
        state.current_position = 0
        state.filtered_data_buffer.clear()
        state.original_data_buffer.clear()
        state.timestamps_buffer.clear()

    state.is_streaming = True
    logger.info(
        f"File streaming {'resumed' if resume else 'started'} "
        f"from position {state.current_position} → WebSocket."
    )

    try:
        while state.is_streaming and state.current_position < n_samples:
            end      = min(state.current_position + chunk_size, n_samples)
            chunk    = data[:, state.current_position:end]
            filtered = apply_all_filters(chunk)
            ts       = state.current_position / sfreq

            state.original_data_buffer.append(chunk)
            state.filtered_data_buffer.append(filtered)
            state.timestamps_buffer.append(ts)

            await websocket.send_json({
                "type":          "eeg_data",
                "timestamp":     round(ts, 4),
                "channel_names": channel_names,
                "sampling_rate": sfreq,
                "original":  [[round(float(v), 4) for v in ch] for ch in chunk.tolist()],
                "filtered":  [[round(float(v), 4) for v in ch] for ch in filtered.tolist()],
            })

            state.current_position = end
            await asyncio.sleep(chunk_duration)

        if state.current_position >= n_samples:
            state.is_streaming = False
            state.pause_position = 0
            state.is_paused = False
            await websocket.send_json({"type": "stream_status", "status": "stopped"})
            logger.info("File streaming complete (end of file).")
        else:
            state.pause_position = state.current_position
            state.is_paused = True
            logger.info(f"File streaming paused at position {state.pause_position}.")

    except Exception as e:
        logger.error(f"File streaming error: {e}")
        state.is_streaming = False


# ─── Export Helpers ───────────────────────────────────────────────────────────
def save_csv(filepath: Path) -> bool:
    try:
        filtered = np.hstack(state.filtered_data_buffer)
        original = np.hstack(state.original_data_buffer)
        n_ch, n_samp = filtered.shape
        sfreq = state.usb_sampling_rate if state.usb_mode else state.current_data["sfreq"]
        ch_names = (
            [f"CH{i+1}" for i in range(state.usb_n_channels)]
            if state.usb_mode
            else state.current_data["channel_names"]
        )
        ts = np.arange(n_samp) / sfreq
        with open(filepath, "w", newline="") as f:
            w = csv.writer(f)
            header = ["Time (s)"]
            for n in ch_names:
                header += [f"{n}_Original", f"{n}_Filtered"]
            w.writerow(header)
            for i in range(n_samp):
                row = [ts[i]]
                for ch in range(n_ch):
                    row += [original[ch, i], filtered[ch, i]]
                w.writerow(row)
        return True
    except Exception as e:
        logger.error(f"CSV export error: {e}")
        return False


def save_edf(filepath: Path) -> bool:
    try:
        filtered = np.hstack(state.filtered_data_buffer) * 1e-6
        sfreq = state.usb_sampling_rate if state.usb_mode else state.current_data["sfreq"]
        ch_names = (
            [f"CH{i+1}" for i in range(state.usb_n_channels)]
            if state.usb_mode
            else state.current_data["channel_names"]
        )
        info = mne.create_info(ch_names=ch_names, sfreq=sfreq, ch_types="eeg")
        mne.io.RawArray(filtered, info).export(str(filepath), overwrite=True)
        return True
    except Exception as e:
        logger.error(f"EDF export error: {e}")
        return False


# ─── REST Endpoints ───────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "version": "4.2.0",
        "firebase_enabled": FIREBASE_ENABLED,
        "streaming": state.is_streaming,
        "data_loaded": state.current_data is not None,
        "usb_mode": state.usb_mode,
        "usb_active": state.usb_streaming_active,
        "active_filters": {
            k: (v is not None) for k, v in state.active_filters.items()
        },
    }


@app.get("/api/serial-ports")
async def list_serial_ports():
    try:
        ports = serial.tools.list_ports.comports()
        return {
            "ports": [
                {"device": p.device, "description": p.description, "hwid": p.hwid}
                for p in ports
            ]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/usb/connect")
async def connect_usb(
    port: str,
    baudrate: int = 115200,
    n_channels: int = 8,
    sampling_rate: int = 250,
):
    try:
        state.stop_usb_streaming()
        state.is_streaming = False
        state.filtered_data_buffer.clear()
        state.original_data_buffer.clear()
        state.timestamps_buffer.clear()

        state.serial_connection = serial.Serial(
            port=port,
            baudrate=baudrate,
            timeout=1,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
        )
        state.usb_mode = True
        state.usb_sampling_rate = sampling_rate
        state.usb_n_channels = n_channels
        state.original_filename = f"usb_{port.replace('/', '_')}_{datetime.now():%Y%m%d_%H%M%S}"
        state.filter_bank = EEGFilterBank(sampling_rate)
        state.active_filters = {"highpass": None, "lowpass": None, "notch": None}

        firebase_update("eeg/device", {
            "port": port,
            "baudrate": baudrate,
            "n_channels": n_channels,
            "sampling_rate": sampling_rate,
            "connected_at": int(time.time() * 1000),
            "status": "connected",
        })

        logger.info(f"USB connected: {port} @ {baudrate} baud, {n_channels} ch, {sampling_rate} Hz")
        return {
            "success": True,
            "port": port,
            "baudrate": baudrate,
            "n_channels": n_channels,
            "sampling_rate": sampling_rate,
        }
    except serial.SerialException as e:
        raise HTTPException(status_code=500, detail=f"Serial error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/usb/disconnect")
async def disconnect_usb():
    state.stop_usb_streaming()
    state.usb_mode = False
    firebase_update("eeg/device", {"status": "disconnected"})
    return {"success": True}


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    if not file.filename.endswith(".edf"):
        raise HTTPException(status_code=400, detail="Only .edf files are supported.")
    try:
        state.stop_usb_streaming()
        state.is_streaming = False
        await asyncio.sleep(0.6)

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        filepath = UPLOAD_FOLDER / f"eeg_{ts}.edf"
        filepath.write_bytes(await file.read())

        state.current_data = load_edf_file(filepath)
        state.original_filename = file.filename
        state.usb_mode = False
        state.filter_bank = EEGFilterBank(state.current_data["sfreq"])
        state.active_filters = {"highpass": None, "lowpass": None, "notch": None}
        state.current_position = 0
        state.pause_position = 0
        state.is_paused = False
        state.filtered_data_buffer.clear()
        state.original_data_buffer.clear()
        state.timestamps_buffer.clear()

        return {
            "success": True,
            "filename": filepath.name,
            "original_filename": file.filename,
            "channels": state.current_data["channel_names"],
            "sampling_rate": state.current_data["sfreq"],
            "duration": state.current_data["duration"],
            "n_channels": state.current_data["n_channels"],
            "n_samples": state.current_data["n_samples"],
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/export")
async def export_data(format: str = "csv"):
    if not state.filtered_data_buffer:
        raise HTTPException(status_code=400, detail="No data to export. Stream first.")
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = (state.original_filename or "eeg").replace(".edf", "")
    if format.lower() == "csv":
        fname = f"{base}_filtered_{ts}.csv"
        ok = save_csv(EXPORT_FOLDER / fname)
    elif format.lower() == "edf":
        fname = f"{base}_filtered_{ts}.edf"
        ok = save_edf(EXPORT_FOLDER / fname)
    else:
        raise HTTPException(status_code=400, detail="Use 'csv' or 'edf'.")
    if not ok:
        raise HTTPException(status_code=500, detail="Export failed.")
    return {
        "success": True,
        "filename": fname,
        "samples_exported": sum(c.shape[1] for c in state.filtered_data_buffer),
    }


@app.get("/api/download/{filename}")
async def download_export(filename: str):
    fp = EXPORT_FOLDER / filename
    if not fp.exists():
        raise HTTPException(status_code=404, detail="File not found.")
    return FileResponse(fp, filename=filename)


# ─── WebSocket ────────────────────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    state.connected_clients.add(websocket)
    loop = asyncio.get_event_loop()
    logger.info("WebSocket client connected.")

    try:
        await websocket.send_json({
            "type": "connection",
            "status": "connected",
            "firebase_enabled": FIREBASE_ENABLED,
            "firebase_usage": "usb_only",
        })

        while True:
            raw   = await websocket.receive_text()
            msg   = json.loads(raw)
            mtype = msg.get("type")

            # ── start_stream ──────────────────────────────────────────────
            if mtype == "start_stream":
                if state.usb_mode:
                    if not (state.serial_connection and state.serial_connection.is_open):
                        await websocket.send_json({"type": "error", "message": "USB not connected."})
                        continue
                    state.usb_streaming_active = True
                    state.is_streaming = True
                    state.filtered_data_buffer.clear()
                    state.original_data_buffer.clear()
                    state.timestamps_buffer.clear()
                    write_status_to_firebase("streaming", {"mode": "usb"})
                    await websocket.send_json({"type": "stream_status", "status": "started", "mode": "usb"})
                    state.usb_thread = threading.Thread(
                        target=usb_read_thread, args=(websocket, loop), daemon=True
                    )
                    state.usb_thread.start()
                else:
                    if state.current_data is None:
                        await websocket.send_json({"type": "error", "message": "No EDF file loaded."})
                        continue
                    is_resume = state.is_paused and state.pause_position > 0
                    await websocket.send_json({
                        "type":   "stream_status",
                        "status": "started",
                        "mode":   "file",
                        "resume": is_resume,
                    })
                    asyncio.create_task(stream_eeg_file(websocket, resume=is_resume))

            # ── pause_stream ──────────────────────────────────────────────
            elif mtype == "pause_stream":
                state.is_streaming = False
                if state.usb_mode:
                    state.usb_streaming_active = False
                    write_status_to_firebase("paused")
                await websocket.send_json({"type": "stream_status", "status": "paused"})

            # ── stop_stream ───────────────────────────────────────────────
            elif mtype == "stop_stream":
                state.is_streaming = False
                state.usb_streaming_active = False
                state.pause_position = 0
                state.is_paused = False
                if state.usb_mode:
                    write_status_to_firebase("stopped")
                await websocket.send_json({"type": "stream_status", "status": "stopped"})

            # ── update_filter ─────────────────────────────────────────────
            # BUG FIX: this entire elif block was missing from the patched version.
            # Filter messages were arriving and being silently dropped.
            elif mtype == "update_filter":
                await handle_filter_update(websocket, msg)

            # ── refilter_buffer ───────────────────────────────────────────
            # NEW: frontend requests a full re-filter of buffered original data
            # so the filtered plot updates immediately when filters are applied
            # mid-stream without waiting for new chunks to arrive.
            elif mtype == "refilter_buffer":
                if state.original_data_buffer:
                    sfreq         = state.current_data["sfreq"] if state.current_data else state.usb_sampling_rate
                    channel_names = state.current_data["channel_names"] if state.current_data else [f"CH{i+1}" for i in range(state.usb_n_channels)]

                    # Re-filter every buffered chunk with current active filters
                    refiltered_chunks = refilter_original_buffer()

                    # Update the server-side filtered buffer to match
                    state.filtered_data_buffer = refiltered_chunks

                    # Build flat arrays to send back in one message
                    original_flat  = np.hstack(state.original_data_buffer)
                    filtered_flat  = np.hstack(refiltered_chunks)
                    n_samples      = original_flat.shape[1]
                    timestamps     = [state.timestamps_buffer[0] + i / sfreq for i in range(n_samples)] if state.timestamps_buffer else []

                    await websocket.send_json({
                        "type":          "buffer_refiltered",
                        "channel_names": channel_names,
                        "sampling_rate": sfreq,
                        "timestamp_start": round(state.timestamps_buffer[0], 4) if state.timestamps_buffer else 0,
                        "original":  [[round(float(v), 4) for v in ch] for ch in original_flat.tolist()],
                        "filtered":  [[round(float(v), 4) for v in ch] for ch in filtered_flat.tolist()],
                        "time":      [round(t, 4) for t in timestamps],
                    })
                    logger.info(f"Buffer refiltered: {n_samples} samples sent back.")
                else:
                    await websocket.send_json({"type": "buffer_refiltered", "empty": True})

    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected.")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        state.connected_clients.discard(websocket)
        state.is_streaming = False
        state.usb_streaming_active = False


# ─── Filter Update Handler ────────────────────────────────────────────────────
async def handle_filter_update(websocket: WebSocket, data: dict):
    if state.filter_bank is None:
        await websocket.send_json({"type": "error", "message": "No data source configured."})
        return
    ftype = data.get("filter_type")
    try:
        if ftype == "highpass":
            cutoff = float(data.get("cutoff", 0))
            design = data.get("filter_design", "butterworth")
            state.filter_types["highpass"] = design
            if cutoff > 0:
                state.active_filters["highpass"] = state.filter_bank.design_highpass(cutoff, filter_type=design)
                await websocket.send_json({"type": "filter_status", "filter": "highpass", "status": "applied", "cutoff": cutoff, "design": design})
            else:
                state.active_filters["highpass"] = None
                await websocket.send_json({"type": "filter_status", "filter": "highpass", "status": "removed"})

        elif ftype == "lowpass":
            cutoff = float(data.get("cutoff", 0))
            design = data.get("filter_design", "butterworth")
            state.filter_types["lowpass"] = design
            if cutoff > 0:
                state.active_filters["lowpass"] = state.filter_bank.design_lowpass(cutoff, filter_type=design)
                await websocket.send_json({"type": "filter_status", "filter": "lowpass", "status": "applied", "cutoff": cutoff, "design": design})
            else:
                state.active_filters["lowpass"] = None
                await websocket.send_json({"type": "filter_status", "filter": "lowpass", "status": "removed"})

        elif ftype == "notch":
            freq    = float(data.get("notch_freq", 50))
            enabled = data.get("enabled", True)
            if enabled:
                state.active_filters["notch"] = state.filter_bank.design_notch(freq)
                await websocket.send_json({"type": "filter_status", "filter": "notch", "status": "applied", "frequency": freq})
            else:
                state.active_filters["notch"] = None
                await websocket.send_json({"type": "filter_status", "filter": "notch", "status": "removed"})

    except Exception as e:
        await websocket.send_json({"type": "error", "message": f"Filter error: {e}"})


if __name__ == "__main__":
    import uvicorn
    print("=" * 70)
    print("EEG Acquisition System v4.2 — Filter Fix Edition")
    print("File mode : WebSocket direct (no Firebase)")
    print("USB mode  : Firebase RTDB")
    print("NIT Tiruchirappalli | Dept. of ICE | Guide: Prof. V. Sridevi")
    print("=" * 70)
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True, log_level="info")
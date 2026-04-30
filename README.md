# 🧠 Browser-Based EEG Acquisition System
### Digital Filtering and Interactive Visualization System

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10%2B-blue?logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/FastAPI-0.110-009688?logo=fastapi&logoColor=white" />
  <img src="https://img.shields.io/badge/Plotly.js-2.27-3F4F75?logo=plotly&logoColor=white" />
  <img src="https://img.shields.io/badge/MNE--Python-1.7-orange" />
  <img src="https://img.shields.io/badge/Firebase-RTDB-FFCA28?logo=firebase&logoColor=black" />
  <img src="https://img.shields.io/badge/License-MIT-green" />
</p>

> **Final Year Project** — Department of Instrumentation and Control Engineering  
> National Institute of Technology, Tiruchirappalli  
> **Guide:** Prof. V. Sridevi

---

## 📌 Project Overview

This project implements a fully browser-based EEG (Electroencephalogram) acquisition, digital filtering, and real-time visualization system. It supports two distinct operating modes:

- **File Mode** — Upload a standard `.edf` EEG file; the Python backend streams processed chunks directly to the browser over WebSocket using MNE-Python and SciPy.
- **USB Live Mode** — A USB EEG device streams raw samples over a serial connection → Python applies filters and writes chunks to Firebase RTDB → the browser reads them in real time via the Firebase JavaScript SDK.

Both modes support multi-channel interactive visualization with four selectable IIR filter designs (Butterworth, Chebyshev Type I & II, Elliptic), a notch filter for power-line noise removal, mid-stream buffer refiltering, and CSV / EDF export.

---

## 🗂️ Repository Structure

```
eeg-acquisition-system/
│
├── app.py                        # FastAPI backend — WebSocket, REST API, signal processing
├── index.html                    # Single-page frontend (no build step required)
├── script.js                     # Frontend logic — WebSocket client, Plotly, Firebase SDK
├── styles.css                    # Dark-themed responsive UI styles
│
├── requirements.txt              # Python dependencies — install with: pip install -r requirements.txt
│
├── firebase-credentials.json     # ⚠️  NOT committed to git — required for USB mode only
│                                 #    Obtain from: Firebase Console → Project Settings →
│                                 #    Service Accounts → Generate new private key
│
├── data/
│   ├── temp/                     # Temporarily holds uploaded EDF files (auto-created on startup)
│   └── exports/                  # Holds exported CSV / EDF files (auto-created on startup)
│
└── README.md                     # This file
```

---

## ✨ Features

| Feature | Details |
|---|---|
| **EDF File Streaming** | Upload any standard `.edf` file; streamed in 0.5 s chunks via WebSocket |
| **USB Live Streaming** | Read raw EEG packets from serial port, parse, filter, push to Firebase RTDB |
| **Digital Filters** | High-pass · Low-pass (Butterworth / Chebyshev I / Chebyshev II / Elliptic) · Notch (50 / 60 Hz) |
| **Real-Time Refiltering** | Changing filters mid-stream instantly refilters the entire accumulated buffer — no need to restart |
| **Multi-Channel Visualization** | Stacked, normalized, colour-coded Plotly traces per channel with hover tooltips |
| **Layout Modes** | Split (stacked) · Side-by-side · Focus Original · Focus Filtered |
| **Drag Resize** | Drag the handle between the two plots to resize them freely in split mode |
| **Expand / Fullscreen** | Per-plot expand button; press ESC to collapse |
| **Channel Visibility** | Click legend entries to toggle individual channels on both plots simultaneously |
| **Display Settings** | Adjustable amplitude scale (μV) and time-window (seconds) |
| **Pause / Resume** | File mode supports mid-stream pause and resume from the exact sample position |
| **Export** | Download filtered data as `.csv` or `.edf` |

---

## 🔧 Requirements

### System Requirements

| Requirement | Minimum |
|---|---|
| Python | **3.10 or higher** |
| Operating System | Windows 10 · macOS 12 · Ubuntu 20.04 |
| Browser | Chrome 110+ · Firefox 115+ · Edge 110+ |
| RAM | 4 GB (8 GB recommended for large EDF files) |
| Internet | Required on first browser load (CDN-hosted Plotly.js and Firebase SDK) |

### Python Dependencies

All Python dependencies are pinned in `requirements.txt`. Install everything in one command:

```bash
pip install -r requirements.txt
```

Core packages used:

| Package | Purpose |
|---|---|
| `fastapi` | Async web framework — REST API and WebSocket server |
| `uvicorn[standard]` | ASGI server to run FastAPI |
| `mne` | EDF file loading, channel metadata, EDF export |
| `scipy` | IIR filter design (`butter`, `cheby1`, `cheby2`, `ellip`, `iirnotch`, `filtfilt`) |
| `numpy` | Array operations for signal data |
| `pyserial` | Serial port communication for USB EEG devices |
| `firebase-admin` | Firebase Admin SDK — writes EEG data to Realtime Database (USB mode only) |
| `python-multipart` | Required by FastAPI to handle `UploadFile` (EDF upload) |
| `websockets` | WebSocket protocol support for uvicorn |

> **Note:** `firebase-admin` is only required for USB live streaming. File (EDF) mode works without it and without `firebase-credentials.json`.

---

## 📦 Installation & Setup

### 1. Clone the repository

```bash
git clone https://github.com/<your-username>/eeg-acquisition-system.git
cd eeg-acquisition-system
```

### 2. Create and activate a virtual environment (strongly recommended)

```bash
# Windows
python -m venv venv
venv\Scripts\activate

# macOS / Linux
python3 -m venv venv
source venv/bin/activate
```

### 3. Install all Python dependencies

```bash
pip install -r requirements.txt
```

> **macOS note:** If `pyserial` does not detect your USB device, you may need the [Silicon Labs CP210x driver](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers).

### 4. Firebase setup — USB mode only

USB live streaming uses Firebase Realtime Database as the low-latency transport layer between the Python backend and the browser.

1. Go to the [Firebase Console](https://console.firebase.google.com/) and open your project.
2. Navigate to **Project Settings → Service Accounts → Generate new private key**.
3. Save the downloaded JSON file as `firebase-credentials.json` in the project root directory.
4. In the Firebase Console, go to **Build → Realtime Database** and create a database in your preferred region.
5. Update the following constants with your project's values:
   - `FIREBASE_DATABASE_URL` in `app.py`
   - `FIREBASE_CONFIG` object in `script.js`

> **File mode works without Firebase.** Skip this step entirely if you only need to visualize EDF files.

### 5. Start the server

```bash
python app.py
```

Or run directly with uvicorn:

```bash
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

### 6. Open the application

Open your browser and navigate to:

```
http://localhost:8000
```

---

## 🖥️ Usage

### File Mode (EDF Upload)

1. Click **"Click to upload EDF file"** in the left sidebar, or drag-and-drop an `.edf` file onto the upload zone.
2. File metadata (filename, channels, sampling rate, duration, sample count) appears automatically.
3. Optionally configure filters in the **Signal Filters** panel — toggle each filter on, set its cutoff frequency and design type, then click **Apply Filters**.
4. Click **▶ Start** to begin streaming.
5. Use **⏸ Pause** / **⏹ Stop** to control playback. Pause remembers the exact sample position; clicking Start again resumes from there.
6. Click **Apply Filters** at any point during streaming — the entire accumulated buffer is instantly refiltered and both plots update immediately.

### USB Live Mode

1. Connect your EEG hardware device via USB.
2. Click **🔄 Refresh Ports** and select the correct serial port from the dropdown.
3. Set the baud rate, channel count, and sampling rate to match your device's firmware configuration.
4. Click **🔌 Connect USB**.
5. Click **▶ Start** to begin live streaming. Data flows: USB → Python → Firebase → Browser.

### Layout Controls

Use the pill buttons above the plots to switch between:

- **Split** — both plots stacked vertically (default); drag the handle between them to resize
- **Side** — plots placed side by side horizontally
- **Original** — original signal large, filtered signal compact
- **Filtered** — filtered signal large, original signal compact

Click the expand icon (⛶) on either plot header to enter fullscreen mode. Press **ESC** to exit.

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         BROWSER                             │
│    index.html · script.js · Plotly.js · Firebase JS SDK    │
└──────────────┬──────────────────────────┬───────────────────┘
               │  WebSocket (file mode)   │  Firebase RTDB SDK (USB mode)
               │                          │
┌──────────────▼──────────────────────────▼───────────────────┐
│                      FastAPI  (app.py)                       │
│  ┌────────────┐  ┌────────────────┐  ┌──────────────────┐   │
│  │  MNE-Py    │  │   SciPy DSP    │  │  pyserial (USB)  │   │
│  │ EDF Parser │  │  Filter Bank   │  │  Packet Parser   │   │
│  └────────────┘  └────────────────┘  └──────────────────┘   │
│                          │                    │              │
│                          │              Firebase Admin SDK   │
│                          │                    │              │
└──────────────────────────┼────────────────────┼─────────────┘
                           │                    ▼
                    WebSocket chunks      Firebase RTDB
                  → Browser directly    (eeg/stream/latest)
```

**File Mode data flow:**
`Browser uploads EDF → MNE parses → SciPy filters → WebSocket chunks → Plotly renders`

**USB Mode data flow:**
`USB Device → pyserial → SciPy filters → Firebase RTDB → Firebase SDK → Plotly renders`

---

## 🎚️ Digital Filter Details

All IIR filters are implemented via `scipy.signal` with zero-phase forward-backward filtering (`filtfilt`), which eliminates phase distortion — important for accurate EEG waveform display.

| Filter | Characteristic | Parameters Used |
|---|---|---|
| **Butterworth** | Maximally flat magnitude in passband | Order 4 |
| **Chebyshev Type I** | Equiripple in passband, monotone stopband | Order 4, 0.5 dB ripple |
| **Chebyshev Type II** | Monotone passband, equiripple in stopband | Order 4, 40 dB attenuation |
| **Elliptic (Cauer)** | Equiripple in both passband and stopband | Order 4, 0.5 dB / 40 dB |
| **Notch** | Sharp notch at power-line frequency | `iirnotch`, Q = 30, 50 Hz or 60 Hz |

When filters are changed mid-stream, the frontend sends a `refilter_buffer` WebSocket message. The server re-applies all active filters to the entire original data buffer and returns the result in a single `buffer_refiltered` message, which replaces the filtered channel data in the browser immediately.

---

## 🔌 API Reference

### REST Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Serves `index.html` |
| `GET` | `/health` | Server health, streaming status, active filters |
| `GET` | `/api/serial-ports` | List available COM / tty serial ports |
| `POST` | `/api/upload` | Upload an EDF file (multipart form data) |
| `POST` | `/api/usb/connect` | Connect to a USB serial EEG device |
| `POST` | `/api/usb/disconnect` | Disconnect the USB device |
| `POST` | `/api/export?format=csv` | Export filtered data as CSV |
| `POST` | `/api/export?format=edf` | Export filtered data as EDF |
| `GET` | `/api/download/{filename}` | Download a previously exported file |
| `WS` | `/ws` | WebSocket endpoint for real-time streaming and filter control |

### WebSocket Message Protocol

| Direction | `type` field | Description |
|---|---|---|
| Client → Server | `start_stream` | Begin streaming (file or USB mode) |
| Client → Server | `pause_stream` | Pause streaming; remembers position |
| Client → Server | `stop_stream` | Stop streaming and reset position |
| Client → Server | `update_filter` | Apply or remove a filter |
| Client → Server | `refilter_buffer` | Re-apply current filters to entire buffered data |
| Server → Client | `eeg_data` | EEG data chunk in file mode |
| Server → Client | `firebase_chunk_ready` | Notification that USB chunk is written to Firebase |
| Server → Client | `stream_status` | `started` / `paused` / `stopped` |
| Server → Client | `filter_status` | Confirmation that a filter was applied or removed |
| Server → Client | `buffer_refiltered` | Full re-filtered buffer in response to `refilter_buffer` |
| Server → Client | `error` | Error message string |

---

## 📁 .gitignore Recommendations

Create a `.gitignore` file in the project root with the following content before your first commit:

```
# Firebase service account key — never commit credentials
firebase-credentials.json

# Uploaded and exported EEG data
data/

# Python virtual environment
venv/
.venv/
__pycache__/
*.pyc
*.pyo
*.pyd

# OS generated files
.DS_Store
Thumbs.db

# IDE and editor files
.vscode/
.idea/
*.swp
```

---

## 🛠️ Troubleshooting

**`ModuleNotFoundError` after installing requirements**
Make sure your virtual environment is activated before running `pip install` and before running `python app.py`.

**USB port not appearing in the dropdown**
Click **🔄 Refresh Ports**. On macOS, ensure the Silicon Labs CP210x driver is installed. On Linux, add your user to the `dialout` group: `sudo usermod -aG dialout $USER` then log out and back in.

**Firebase connection errors**
Verify that `firebase-credentials.json` is present in the project root, that `FIREBASE_DATABASE_URL` in `app.py` matches your project, and that Realtime Database rules allow read/write (for development, set rules to `true`).

**Plotly plots not resizing correctly after layout change**
This is handled automatically by the two-pass resize in `initLayoutControls()`. If it persists, try refreshing the page and switching layouts again.

**`filtfilt` raises `ValueError` about signal length**
This happens when the accumulated buffer is too short for the filter order. It resolves itself once more data accumulates. The filter is order 4, so at least ~20 samples are needed.

---

## 🤝 Acknowledgements

- **MNE-Python** — EEG/MEG data handling and EDF file parsing/export
- **SciPy** — Digital signal processing: filter design and zero-phase application
- **FastAPI** — Modern, async Python web framework with automatic OpenAPI docs
- **Plotly.js** — Interactive, publication-quality scientific visualization in the browser
- **Firebase Realtime Database** — Low-latency pub/sub transport for USB live streaming
- **pyserial** — Cross-platform serial port communication

---

## 📄 License

This project is developed for academic purposes as part of the Final Year Project programme at the **National Institute of Technology, Tiruchirappalli**.

---

<p align="center">
  Made with ❤️ at NIT Tiruchirappalli &nbsp;|&nbsp; Department of Instrumentation and Control Engineering<br>
  <strong>Guide: Prof. V. Sridevi</strong>
</p>

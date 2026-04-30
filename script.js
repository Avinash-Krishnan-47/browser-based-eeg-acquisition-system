// ─── Firebase Configuration ───────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCcQzj15ahVkOso6cItH6bMbOxs0j9YAUE",
  authDomain: "eeg-fyp.firebaseapp.com",
  databaseURL: "https://eeg-fyp-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "eeg-fyp",
  storageBucket: "eeg-fyp.firebasestorage.app",
  messagingSenderId: "34113376732",
  appId: "1:34113376732:web:13b1adf9e39fddbb1fff19"
};

// ─── Server Config ────────────────────────────────────────────────────────────
const CONFIG = {
    API_URL: 'http://localhost:8000',
    WS_URL:  'ws://localhost:8000/ws',
    MAX_RECONNECT_ATTEMPTS: 5,
    RECONNECT_DELAY: 3000
};

// ─── Application State ────────────────────────────────────────────────────────
const state = {
    websocket: null,
    isConnected: false,
    reconnectAttempts: 0,
    usbMode: false,
    isPaused: false,
    pausePosition: 0,
    firebaseApp: null,
    firebaseDB: null,
    firebaseListener: null,

    eegData: {
        original: { channels: [], timeData: [] },
        filtered: { channels: [], timeData: [] },
        channelNames: [],
        maxPoints: 2500,
        samplingRate: 250,
        isStreaming: false,
        hasFilteredData: false
    },

    plotConfig: {
        amplitudeScale:     20,
        timeWindow:         10,
        baselineSpacing:    100,
        normalizePerChannel: true
    },

    channelScales:      [],
    channelMeans:       [],
    channelVisibility:  [],
    fileInfo:           null,

    // ── BUG 2 + 3 FIX: track pending filter acknowledgements ──────────────
    // Each time applyFilters() is called we increment this counter.
    // handleFilterStatus counts down; when it hits 0 we know ALL filter
    // messages have been acknowledged by the server and we trigger a
    // refilter_buffer request so the existing buffer is re-rendered instantly.
    _pendingFilterAcks: 0,
    _filterAckCount:    0,
};

// ─── Initialisation ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    console.log('🧠 EEG Acquisition System v4.2 — Filter Fix');

    setTimeout(() => {
        document.getElementById('loadingScreen').classList.add('hidden');
    }, 1500);

    initFirebase();
    initializeWebSocket();
    setupEventListeners();
    setupDragAndDrop();
    loadSerialPorts();
    initLayoutControls();

    console.log('✅ System Ready');
});

// ─── Firebase Initialisation ──────────────────────────────────────────────────
function initFirebase() {
    try {
        const script1 = document.createElement('script');
        script1.src = 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js';
        script1.onload = () => {
            const script2 = document.createElement('script');
            script2.src = 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database-compat.js';
            script2.onload = () => {
                state.firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
                state.firebaseDB  = firebase.database();
                console.log('🔥 Firebase ready (USB mode only):', FIREBASE_CONFIG.databaseURL);
                listenToStreamStatus();
            };
            document.head.appendChild(script2);
        };
        document.head.appendChild(script1);
    } catch (err) {
        console.error('Firebase init error:', err);
        showToast('Firebase init failed — USB streaming may not work', 'warning');
    }
}

// ─── Firebase Listeners (USB ONLY) ───────────────────────────────────────────
function startFirebaseListener() {
    if (!state.firebaseDB) { showToast('Firebase not ready', 'warning'); return; }
    stopFirebaseListener();
    const ref = state.firebaseDB.ref('eeg/stream/latest');
    state.firebaseListener = ref.on('value', (snapshot) => {
        const data = snapshot.val();
        if (data) handleFirebaseChunk(data);
    }, (err) => {
        console.error('Firebase listener error:', err);
        showToast('Firebase read error', 'error');
    });
    console.log('🔥 Firebase listener active (USB mode)');
}

function stopFirebaseListener() {
    if (state.firebaseDB && state.firebaseListener) {
        state.firebaseDB.ref('eeg/stream/latest').off('value', state.firebaseListener);
        state.firebaseListener = null;
        console.log('🔥 Firebase listener removed');
    }
}

function listenToStreamStatus() {
    if (!state.firebaseDB) return;
    state.firebaseDB.ref('eeg/stream/status').on('value', (snapshot) => {
        const s = snapshot.val();
        if (!s) return;
        const indicator     = document.getElementById('streamIndicator');
        const indicatorText = indicator.querySelector('.indicator-text');
        indicator.classList.remove('streaming');
        if (s.status === 'streaming') {
            indicator.classList.add('streaming');
            indicatorText.textContent = 'USB → Firebase';
        } else if (s.status === 'paused') {
            indicatorText.textContent = 'Paused';
        } else {
            indicatorText.textContent = 'Idle';
        }
    });
}

// ─── Firebase Chunk Handler (USB ONLY) ───────────────────────────────────────
function handleFirebaseChunk(data) {
    const { original, filtered, timestamp, channel_names } = data;
    if (!original || !filtered) return;

    if (channel_names && state.eegData.channelNames.length === 0) {
        setupChannels(channel_names, data.sampling_rate || state.eegData.samplingRate);
        initializePlots();
    }

    document.querySelector('.time-value').textContent = `${parseFloat(timestamp).toFixed(2)}s`;
    accumulateChunkData(original, filtered, timestamp);
    state.eegData.hasFilteredData = true;
    updatePlots();
}

// ─── WebSocket Message Handler ────────────────────────────────────────────────
function handleWebSocketMessage(event) {
    try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {

            case 'connection':
                console.log('WS connected. Firebase enabled on server:', msg.firebase_enabled);
                break;

            // FILE MODE: data arrives directly via WebSocket
            case 'eeg_data':
                handleDirectEEGData(msg);
                break;

            // USB MODE: Firebase chunk ping — Firebase listener handles the data
            case 'firebase_chunk_ready':
                console.debug('Firebase chunk ready at t=', msg.timestamp);
                break;

            case 'stream_status':
                handleStreamStatus(msg.status, msg.mode, msg.resume);
                break;

            // ── BUG 1 FIX: filter_status now triggers buffer refilter ──────
            case 'filter_status':
                handleFilterStatus(msg);
                break;

            // ── BUG 2+3 FIX: server sends back entire re-filtered buffer ───
            case 'buffer_refiltered':
                handleBufferRefiltered(msg);
                break;

            case 'error':
                showToast(msg.message, 'error');
                break;

            default:
                console.warn('Unknown WS message type:', msg.type);
        }
    } catch (err) {
        console.error('WS message parse error:', err);
    }
}

// ─── Direct EEG Data Handler (FILE MODE) ─────────────────────────────────────
function handleDirectEEGData(msg) {
    const { original, filtered, timestamp, channel_names, sampling_rate } = msg;
    if (!original || !filtered) return;

    if (channel_names && state.eegData.channelNames.length === 0) {
        setupChannels(channel_names, sampling_rate || state.eegData.samplingRate);
        initializePlots();
    }

    document.querySelector('.time-value').textContent =
        `${parseFloat(timestamp).toFixed(2)}s`;

    accumulateChunkData(original, filtered, timestamp);
    state.eegData.hasFilteredData = true;
    updatePlots();
}

// ─── BUG 2+3 FIX: Handle full buffer refilter response from server ────────────
// When the server re-filters the entire original buffer and sends it back,
// we replace the frontend filtered buffer wholesale and re-render both plots.
// This makes filter changes appear INSTANTLY on all accumulated data,
// not just on future incoming chunks.
function handleBufferRefiltered(msg) {
    if (msg.empty) {
        console.log('Buffer refilter: server buffer was empty (nothing to update).');
        return;
    }

    const { original, filtered, time, channel_names, sampling_rate } = msg;
    if (!original || !filtered || !time) return;

    const nCh      = original.length;
    const maxPoints = state.eegData.maxPoints;

    // Replace the ENTIRE filtered buffer with the freshly filtered data.
    // We keep only the last maxPoints samples so the window stays consistent.
    for (let i = 0; i < nCh && i < state.eegData.channelNames.length; i++) {
        const ch = filtered[i];
        state.eegData.filtered.channels[i] = ch.length > maxPoints
            ? ch.slice(-maxPoints)
            : [...ch];
    }

    // Also refresh the original buffer in case it drifted
    for (let i = 0; i < nCh && i < state.eegData.channelNames.length; i++) {
        const ch = original[i];
        state.eegData.original.channels[i] = ch.length > maxPoints
            ? ch.slice(-maxPoints)
            : [...ch];
    }

    // Rebuild time array from the server-provided timestamps
    const timeSlice = time.length > maxPoints ? time.slice(-maxPoints) : [...time];
    state.eegData.original.timeData = timeSlice;
    state.eegData.filtered.timeData = [...timeSlice];

    // Recompute normalization scales for both original and filtered
    recomputeChannelScales();

    // Re-render both plots immediately
    updatePlots();

    state.eegData.hasFilteredData = true;
    console.log(`✅ Buffer refiltered and re-rendered: ${time.length} samples across ${nCh} channels.`);
}

// ─── Shared Channel Setup ─────────────────────────────────────────────────────
function setupChannels(channelNames, samplingRate) {
    state.eegData.channelNames  = channelNames;
    state.eegData.samplingRate  = samplingRate || state.eegData.samplingRate;
    state.eegData.original.channels = channelNames.map(() => []);
    state.eegData.original.timeData = [];
    state.eegData.filtered.channels = channelNames.map(() => []);
    state.eegData.filtered.timeData = [];
    state.channelVisibility = channelNames.map(() => true);
    state.channelScales     = channelNames.map(() => null);
    state.channelMeans      = channelNames.map(() => 0);
    updateMaxPoints();
}

// ─── Shared Chunk Accumulator ─────────────────────────────────────────────────
function accumulateChunkData(original, filtered, timestamp) {
    const sr      = state.eegData.samplingRate;
    const maxPts  = state.eegData.maxPoints;

    for (let i = 0; i < original.length && i < state.eegData.channelNames.length; i++) {
        state.eegData.original.channels[i].push(...original[i]);
        if (state.eegData.original.channels[i].length > maxPts)
            state.eegData.original.channels[i] = state.eegData.original.channels[i].slice(-maxPts);
    }
    for (let i = 0; i < filtered.length && i < state.eegData.channelNames.length; i++) {
        state.eegData.filtered.channels[i].push(...filtered[i]);
        if (state.eegData.filtered.channels[i].length > maxPts)
            state.eegData.filtered.channels[i] = state.eegData.filtered.channels[i].slice(-maxPts);
    }

    const chunkLen = original[0].length;
    for (let j = 0; j < chunkLen; j++)
        state.eegData.original.timeData.push(timestamp + j / sr);
    if (state.eegData.original.timeData.length > maxPts)
        state.eegData.original.timeData = state.eegData.original.timeData.slice(-maxPts);

    state.eegData.filtered.timeData = [...state.eegData.original.timeData];
    recomputeChannelScales();
}

// ─── Per-Channel Normalization ────────────────────────────────────────────────
function recomputeChannelScales() {
    const targetHeight = state.plotConfig.baselineSpacing * 0.75;
    const nCh = state.eegData.channelNames.length;
    for (let i = 0; i < nCh; i++) {
        const ch = state.eegData.original.channels[i];
        if (!ch || ch.length < 2) continue;
        const mean     = ch.reduce((s, v) => s + v, 0) / ch.length;
        const centered = ch.map(v => v - mean);
        const peakAbs  = Math.max(...centered.map(Math.abs));
        state.channelMeans[i]  = mean;
        state.channelScales[i] = peakAbs > 0.01 ? (targetHeight / 2) / peakAbs : 1;
    }
}

function recomputeFilteredChannelScales() {
    const targetHeight = state.plotConfig.baselineSpacing * 0.75;
    const nCh = state.eegData.channelNames.length;
    const scales = [], means = [];
    for (let i = 0; i < nCh; i++) {
        const ch = state.eegData.filtered.channels[i];
        if (!ch || ch.length < 2) {
            scales.push(state.channelScales[i] || 1);
            means.push(state.channelMeans[i]  || 0);
            continue;
        }
        const mean     = ch.reduce((s, v) => s + v, 0) / ch.length;
        const centered = ch.map(v => v - mean);
        const peakAbs  = Math.max(...centered.map(Math.abs));
        means.push(mean);
        scales.push(peakAbs > 0.01 ? (targetHeight / 2) / peakAbs : 1);
    }
    return { scales, means };
}

function normalizeChannel(rawData, mean, scale, baseline) {
    return rawData.map(v => (v - mean) * scale + baseline);
}

// ─── WebSocket Management ─────────────────────────────────────────────────────
function initializeWebSocket() {
    try {
        state.websocket           = new WebSocket(CONFIG.WS_URL);
        state.websocket.onopen    = handleWebSocketOpen;
        state.websocket.onmessage = handleWebSocketMessage;
        state.websocket.onerror   = handleWebSocketError;
        state.websocket.onclose   = handleWebSocketClose;
    } catch (err) {
        console.error('WebSocket error:', err);
        showToast('Failed to connect to server', 'error');
    }
}

function handleWebSocketOpen() {
    state.isConnected       = true;
    state.reconnectAttempts = 0;
    updateConnectionStatus(true);
    showToast('Connected to server', 'success');
}

function handleWebSocketError()  { updateConnectionStatus(false); }

function handleWebSocketClose() {
    state.isConnected = false;
    updateConnectionStatus(false);
    if (state.reconnectAttempts < CONFIG.MAX_RECONNECT_ATTEMPTS) {
        state.reconnectAttempts++;
        showToast(`Reconnecting… (${state.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS})`, 'warning');
        setTimeout(initializeWebSocket, CONFIG.RECONNECT_DELAY);
    } else {
        showToast('Connection lost. Please refresh the page.', 'error');
    }
}

function sendWebSocketMessage(data) {
    if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
        state.websocket.send(JSON.stringify(data));
    } else {
        showToast('Not connected to server', 'error');
    }
}

// ─── USB Functions ────────────────────────────────────────────────────────────
async function loadSerialPorts() {
    try {
        const res  = await fetch(`${CONFIG.API_URL}/api/serial-ports`);
        const data = await res.json();
        const sel  = document.getElementById('selectSerialPort');
        sel.innerHTML = '<option value="">Select Port...</option>';
        data.ports.forEach(p => {
            const opt       = document.createElement('option');
            opt.value       = p.device;
            opt.textContent = `${p.device} — ${p.description}`;
            sel.appendChild(opt);
        });
    } catch (err) {
        console.error('Error loading serial ports:', err);
    }
}

async function connectUSB() {
    const port        = document.getElementById('selectSerialPort').value;
    const baudrate    = parseInt(document.getElementById('selectBaudRate').value);
    const n_channels  = parseInt(document.getElementById('inputChannels').value);
    const sampling_rate = parseInt(document.getElementById('inputSamplingRate').value);

    if (!port) { showToast('Please select a serial port', 'warning'); return; }
    showToast('Connecting to USB device…', 'info');

    try {
        const res  = await fetch(
            `${CONFIG.API_URL}/api/usb/connect?port=${encodeURIComponent(port)}&baudrate=${baudrate}&n_channels=${n_channels}&sampling_rate=${sampling_rate}`,
            { method: 'POST' }
        );
        const data = await res.json();
        if (data.success) {
            state.usbMode             = true;
            state.eegData.samplingRate = sampling_rate;
            state.eegData.channelNames = [];
            updateMaxPoints();
            document.getElementById('usbStatus').innerHTML = '<div class="status-badge usb-connected">Connected</div>';
            document.getElementById('btnUSBConnect').style.display    = 'none';
            document.getElementById('btnUSBDisconnect').style.display = 'block';
            document.getElementById('btnStart').disabled = false;
            showToast('USB device connected!', 'success');
        }
    } catch (err) {
        showToast('Failed to connect USB device', 'error');
    }
}

async function disconnectUSB() {
    try {
        await fetch(`${CONFIG.API_URL}/api/usb/disconnect`, { method: 'POST' });
        state.usbMode = false;
        stopFirebaseListener();
        document.getElementById('usbStatus').innerHTML = '<div class="status-badge usb-disconnected">Disconnected</div>';
        document.getElementById('btnUSBConnect').style.display    = 'block';
        document.getElementById('btnUSBDisconnect').style.display = 'none';
        showToast('USB device disconnected', 'info');
    } catch (err) {
        console.error('Disconnect error:', err);
    }
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
function setupEventListeners() {
    document.getElementById('fileInput').addEventListener('change', handleFileSelect);

    document.getElementById('btnStart').addEventListener('click', startStreaming);
    document.getElementById('btnPause').addEventListener('click', pauseStreaming);
    document.getElementById('btnStop').addEventListener('click',  stopStreaming);

    document.getElementById('btnApplyFilters').addEventListener('click', applyFilters);

    document.getElementById('inputAmplitude').addEventListener('change',   updateDisplaySettings);
    document.getElementById('inputTimeWindow').addEventListener('change',  updateDisplaySettings);
    document.getElementById('inputAmplitude').addEventListener('keypress', e => { if (e.key === 'Enter') updateDisplaySettings(); });
    document.getElementById('inputTimeWindow').addEventListener('keypress', e => { if (e.key === 'Enter') updateDisplaySettings(); });

    document.getElementById('btnRefreshPorts').addEventListener('click',     loadSerialPorts);
    document.getElementById('btnUSBConnect').addEventListener('click',       connectUSB);
    document.getElementById('btnUSBDisconnect').addEventListener('click',    disconnectUSB);
}

// ─── Drag and Drop ────────────────────────────────────────────────────────────
function setupDragAndDrop() {
    const zone = document.getElementById('uploadZone');
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev =>
        zone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); })
    );
    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, () => zone.classList.add('dragging')));
    ['dragleave', 'drop'].forEach(ev     => zone.addEventListener(ev, () => zone.classList.remove('dragging')));
    zone.addEventListener('drop', e => {
        if (e.dataTransfer.files.length > 0) uploadFile(e.dataTransfer.files[0]);
    });
}

// ─── File Upload ──────────────────────────────────────────────────────────────
function handleFileSelect(event) {
    if (event.target.files[0]) uploadFile(event.target.files[0]);
}

async function uploadFile(file) {
    if (!file.name.endsWith('.edf')) { showToast('Please select a valid .edf file', 'error'); return; }
    showToast('Uploading file…', 'info');
    const form = new FormData();
    form.append('file', file);

    try {
        const res  = await fetch(`${CONFIG.API_URL}/api/upload`, { method: 'POST', body: form });
        const data = await res.json();

        if (data.success) {
            state.usbMode  = false;
            state.fileInfo = data;

            document.getElementById('fileMetadata').style.display = 'block';
            document.getElementById('metaFilename').textContent    = data.original_filename || data.filename;
            document.getElementById('metaChannels').textContent    = data.n_channels;
            document.getElementById('metaSamplingRate').textContent = `${data.sampling_rate} Hz`;
            document.getElementById('metaDuration').textContent    = `${data.duration.toFixed(2)} s`;
            document.getElementById('metaSamples').textContent     = data.n_samples.toLocaleString();

            setupChannels(data.channels, data.sampling_rate);
            initializePlots();

            document.getElementById('btnStart').disabled = false;
            showToast('File loaded successfully!', 'success');
        }
    } catch (err) {
        showToast(`Upload failed: ${err.message}`, 'error');
    }
}

// ─── Streaming Controls ───────────────────────────────────────────────────────
function startStreaming() {
    sendWebSocketMessage({ type: 'start_stream' });
    if (state.usbMode) startFirebaseListener();

    document.getElementById('btnStart').disabled = true;
    document.getElementById('btnPause').disabled = false;
    document.getElementById('btnStop').disabled  = false;
}

function pauseStreaming() {
    state.isPaused = true;
    sendWebSocketMessage({ type: 'pause_stream' });
    if (state.usbMode) stopFirebaseListener();

    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnPause').disabled = true;
}

function stopStreaming() {
    state.isPaused = false;
    sendWebSocketMessage({ type: 'stop_stream' });
    if (state.usbMode) stopFirebaseListener();

    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnPause').disabled = true;
    document.getElementById('btnStop').disabled  = true;
}

function handleStreamStatus(status, mode, resume) {
    const indicator     = document.getElementById('streamIndicator');
    const indicatorText = indicator.querySelector('.indicator-text');
    indicator.classList.remove('streaming');

    if (status === 'started') {
        indicator.classList.add('streaming');
        indicatorText.textContent    = mode === 'usb' ? 'USB → Firebase' : 'File → WebSocket';
        state.eegData.isStreaming    = true;

        if (!resume && !state.isPaused) {
            const nCh = state.eegData.channelNames.length;
            state.eegData.original.channels = Array.from({ length: nCh }, () => []);
            state.eegData.filtered.channels = Array.from({ length: nCh }, () => []);
            state.eegData.original.timeData = [];
            state.eegData.filtered.timeData = [];
        }
        state.isPaused = false;

    } else if (status === 'paused') {
        indicatorText.textContent = 'Paused';
        state.eegData.isStreaming = false;

    } else {
        indicatorText.textContent = 'Idle';
        state.eegData.isStreaming = false;
        state.isPaused            = false;
    }
}

// ─── Filter Application ───────────────────────────────────────────────────────
// BUG 1 FIX: applyFilters now counts how many filter messages it sends so that
// handleFilterStatus can count acknowledgements and trigger refilter_buffer
// only after ALL filters have been confirmed by the server.
// This prevents a race condition where refilter_buffer is requested before
// the server has finished updating all active_filters.
function applyFilters() {
    const filters        = [];
    let   pendingCount   = 0;

    // ── High-pass ──────────────────────────────────────────────────────────
    if (document.getElementById('filterHighpass').checked) {
        const cutoff = parseFloat(document.getElementById('inputHighpass').value);
        const design = document.getElementById('selectHighpassType').value;
        if (cutoff > 0) {
            sendWebSocketMessage({ type: 'update_filter', filter_type: 'highpass', cutoff, filter_design: design });
            filters.push(`HPF: ${cutoff} Hz (${getFilterTypeName(design)})`);
            pendingCount++;
        }
    } else {
        sendWebSocketMessage({ type: 'update_filter', filter_type: 'highpass', cutoff: 0 });
        pendingCount++;
    }

    // ── Low-pass ───────────────────────────────────────────────────────────
    if (document.getElementById('filterLowpass').checked) {
        const cutoff = parseFloat(document.getElementById('inputLowpass').value);
        const design = document.getElementById('selectLowpassType').value;
        if (cutoff > 0) {
            sendWebSocketMessage({ type: 'update_filter', filter_type: 'lowpass', cutoff, filter_design: design });
            filters.push(`LPF: ${cutoff} Hz (${getFilterTypeName(design)})`);
            pendingCount++;
        }
    } else {
        sendWebSocketMessage({ type: 'update_filter', filter_type: 'lowpass', cutoff: 0 });
        pendingCount++;
    }

    // ── Notch ──────────────────────────────────────────────────────────────
    if (document.getElementById('filterNotch').checked) {
        const freq = parseFloat(document.getElementById('selectNotch').value);
        sendWebSocketMessage({ type: 'update_filter', filter_type: 'notch', notch_freq: freq, enabled: true });
        filters.push(`Notch: ${freq} Hz`);
        pendingCount++;
    } else {
        sendWebSocketMessage({ type: 'update_filter', filter_type: 'notch', enabled: false });
        pendingCount++;
    }

    // Set counters so handleFilterStatus knows when all acks are in
    state._pendingFilterAcks = pendingCount;
    state._filterAckCount    = 0;

    updateActiveFiltersDisplay(filters);
}

function getFilterTypeName(t) {
    return { butterworth: 'Butterworth', chebyshev1: 'Chebyshev I', chebyshev2: 'Chebyshev II', elliptic: 'Elliptic' }[t] || t;
}

// ─── BUG 1+2+3 FIX: handleFilterStatus now triggers immediate buffer re-render ─
// Previously this only showed a toast.
// Now: it counts down pending acks, and once ALL filters are acknowledged
// by the server it sends refilter_buffer → server re-applies all filters to
// the full original buffer → handleBufferRefiltered replaces filtered channels
// → updatePlots() re-renders everything instantly.
function handleFilterStatus(msg) {
    const { filter, status, design } = msg;
    const name = design ? ` (${getFilterTypeName(design)})` : '';
    showToast(
        status === 'applied'
            ? `${filter} filter applied${name}`
            : `${filter} filter removed`,
        status === 'applied' ? 'success' : 'info'
    );

    // Count this acknowledgement
    state._filterAckCount++;

    // Once all pending filter messages are acknowledged, request full buffer refilter
    if (state._filterAckCount >= state._pendingFilterAcks && state._pendingFilterAcks > 0) {
        state._pendingFilterAcks = 0;
        state._filterAckCount    = 0;

        // Only request refilter if we actually have buffered data to re-render
        const hasData = state.eegData.original.channels.some(ch => ch && ch.length > 0);
        if (hasData) {
            console.log('All filter acks received → requesting buffer refilter from server');
            sendWebSocketMessage({ type: 'refilter_buffer' });
        }
    }
}

function updateActiveFiltersDisplay(filters) {
    const c = document.getElementById('activeFiltersDisplay');
    c.innerHTML = filters.length
        ? filters.map(f => `<span class="filter-tag">${f}</span>`).join('')
        : '<p class="no-filters-text">No filters applied</p>';
}

// ─── Display Settings ─────────────────────────────────────────────────────────
function updateDisplaySettings() {
    const amp = parseFloat(document.getElementById('inputAmplitude').value);
    const tw  = parseFloat(document.getElementById('inputTimeWindow').value);
    if (!isNaN(amp) && amp > 0) {
        state.plotConfig.amplitudeScale  = amp;
        state.plotConfig.baselineSpacing = amp * 5;
    }
    if (!isNaN(tw) && tw > 0) state.plotConfig.timeWindow = tw;
    updateMaxPoints();

    if (state.eegData.channelNames.length > 0) {
        recomputeChannelScales();
        updatePlotLayouts();
        showToast(`Display updated: ${state.plotConfig.amplitudeScale}μV, ${state.plotConfig.timeWindow}s`, 'success');
    }
}

function updateMaxPoints() {
    state.eegData.maxPoints = Math.floor(state.plotConfig.timeWindow * state.eegData.samplingRate);
}

// ─── Plotting Functions ───────────────────────────────────────────────────────
function initializePlots() {
    initializePlot('Original', 'plotPlaceholderOriginal', 'plotContainerOriginal');
    initializePlot('Filtered', 'plotPlaceholderFiltered', 'plotContainerFiltered');
}

function initializePlot(plotType, placeholderId, containerId) {
    document.getElementById(placeholderId).style.display = 'none';
    document.getElementById(containerId).style.display   = 'block';

    const traces = state.eegData.channelNames.map((name, i) => ({
        x: [], y: [],
        type: 'scatter', mode: 'lines',
        name,
        line:       { color: getChannelColor(i), width: 1.5 },
        showlegend: true,
        visible:    true,
        customdata: [],
        hovertemplate: '<b>%{fullData.name}</b><br>Time: %{x:.3f}s<br>Amplitude: %{customdata:.2f} μV<extra></extra>'
    }));

    const layout = buildLayout(plotType);
    const config = {
        responsive:           true,
        displayModeBar:       true,
        displaylogo:          false,
        modeBarButtonsToRemove: ['lasso2d', 'select2d']
    };

    Plotly.newPlot(containerId, traces, layout, config);

    document.getElementById(containerId).on('plotly_legendclick', (eventData) => {
        const idx        = eventData.curveNumber;
        state.channelVisibility[idx] = !state.channelVisibility[idx];
        const newVisible = state.channelVisibility[idx] ? true : 'legendonly';
        ['plotContainerOriginal', 'plotContainerFiltered'].forEach(id => {
            const el = document.getElementById(id);
            if (el && el.data) Plotly.restyle(id, { visible: newVisible }, [idx]);
        });
        return false;
    });
}

function buildLayout(plotType) {
    const spacing = state.plotConfig.baselineSpacing;
    const n       = state.eegData.channelNames.length;
    return {
        title:        { text: `${plotType} EEG Signal`, font: { color: '#f1f5f9', size: 16 } },
        paper_bgcolor: '#1e293b',
        plot_bgcolor:  '#0f172a',
        font:          { color: '#cbd5e1' },
        xaxis: {
            title: 'Time (seconds)', gridcolor: '#334155', color: '#cbd5e1', zeroline: false,
            showspikes: true, spikecolor: '#60a5fa', spikethickness: 1, spikedash: 'solid', spikemode: 'across'
        },
        yaxis: {
            title: 'Channel', gridcolor: '#334155', color: '#cbd5e1',
            range:    calculateYAxisRange(spacing, n),
            tickmode: 'array',
            tickvals: getChannelTickPositions(spacing),
            ticktext: getChannelTickLabels(),
            tickfont: { size: 11, color: '#cbd5e1', family: 'monospace' },
            zeroline: false,
            showspikes: true, spikecolor: '#60a5fa', spikethickness: 1, spikedash: 'solid', spikemode: 'across'
        },
        showlegend: true,
        legend: {
            x: 1.02, y: 1, xanchor: 'left', yanchor: 'top',
            bgcolor: 'rgba(30,41,59,0.9)', bordercolor: '#334155', borderwidth: 1,
            font:    { size: 10, color: '#cbd5e1' }
        },
        margin:        { t: 50, r: 150, b: 70, l: 100 },
        hovermode:     'x unified',
        hoverdistance: 50,
        spikedistance: -1,
        shapes:        getBaselineShapes(spacing)
    };
}

function getChannelTickPositions(spacing) {
    const sp = spacing !== undefined ? spacing : state.plotConfig.baselineSpacing;
    return state.eegData.channelNames.map((_, i) => i * sp);
}

function getChannelTickLabels() {
    return state.eegData.channelNames;
}

function getBaselineShapes(spacing) {
    const sp = spacing !== undefined ? spacing : state.plotConfig.baselineSpacing;
    return state.eegData.channelNames.map((_, i) => ({
        type: 'line', x0: 0, x1: 1, xref: 'paper',
        y0: i * sp, y1: i * sp, yref: 'y',
        line: { color: '#475569', width: 1, dash: 'dot' }
    }));
}

function updatePlots() {
    updatePlot('plotContainerOriginal', state.eegData.original, false);
    updatePlot('plotContainerFiltered', state.eegData.filtered, true);
}

function updatePlot(containerId, dataSource, isFiltered) {
    const container = document.getElementById(containerId);
    if (!container || container.style.display === 'none') return;
    if (!container.data || container.data.length === 0)   return;

    const spacing = state.plotConfig.baselineSpacing;
    const nCh     = dataSource.channels.length;

    let scales, means;
    if (isFiltered) {
        const computed = recomputeFilteredChannelScales();
        scales = computed.scales;
        means  = computed.means;
    } else {
        scales = state.channelScales;
        means  = state.channelMeans;
    }

    const xUpdates          = [];
    const yUpdates          = [];
    const customdataUpdates = [];
    const visibleUpdates    = [];

    for (let i = 0; i < nCh; i++) {
        xUpdates.push(dataSource.timeData);
        const baseline = i * spacing;
        const scale    = scales[i] || 1;
        const mean     = means[i]  || 0;
        const ch       = dataSource.channels[i];

        if (!ch || ch.length === 0) {
            yUpdates.push([]);
            customdataUpdates.push([]);
        } else {
            yUpdates.push(normalizeChannel(ch, mean, scale, baseline));
            customdataUpdates.push(ch);
        }
        visibleUpdates.push(state.channelVisibility[i] ? true : 'legendonly');
    }

    const traceIndices = Array.from({ length: nCh }, (_, i) => i);
    Plotly.update(containerId,
        { x: xUpdates, y: yUpdates, customdata: customdataUpdates, visible: visibleUpdates },
        {},
        traceIndices
    );

    const n = state.eegData.channelNames.length;
    Plotly.relayout(containerId, {
        'yaxis.range':    calculateYAxisRange(spacing, n),
        'yaxis.tickvals': getChannelTickPositions(spacing),
        'yaxis.ticktext': getChannelTickLabels(),
        shapes:           getBaselineShapes(spacing)
    });
}

function updatePlotLayouts() {
    ['plotContainerOriginal', 'plotContainerFiltered'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.style.display !== 'none') {
            const spacing = state.plotConfig.baselineSpacing;
            const n       = state.eegData.channelNames.length;
            Plotly.relayout(id, {
                'yaxis.range':    calculateYAxisRange(spacing, n),
                'yaxis.tickvals': getChannelTickPositions(spacing),
                'yaxis.ticktext': getChannelTickLabels(),
                shapes:           getBaselineShapes(spacing)
            });
        }
    });
    if (state.eegData.original.channels.some(ch => ch.length > 0)) updatePlots();
}

function calculateYAxisRange(spacing, n) {
    const sp    = spacing !== undefined ? spacing : state.plotConfig.baselineSpacing;
    const count = n       !== undefined ? n       : state.eegData.channelNames.length;
    if (count === 0) return [-100, 100];
    const pad = sp * 0.8;
    return [-pad, (count - 1) * sp + pad];
}

function getChannelColor(i) {
    const colors = [
        '#3b82f6','#8b5cf6','#ec4899','#f59e0b','#10b981',
        '#06b6d4','#6366f1','#a855f7','#14b8a6','#f43f5e',
        '#84cc16','#fb923c','#e11d48','#0891b2','#7c3aed','#059669'
    ];
    return colors[i % colors.length];
}

// ─── Export ───────────────────────────────────────────────────────────────────
async function exportData(format) {
    showToast(`Exporting as ${format.toUpperCase()}…`, 'info');
    try {
        const res  = await fetch(`${CONFIG.API_URL}/api/export?format=${format}`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast(`Exported ${data.samples_exported.toLocaleString()} samples`, 'success');
            const link    = document.createElement('a');
            link.href     = `${CONFIG.API_URL}/api/download/${data.filename}`;
            link.download = data.filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
    } catch (err) {
        showToast(`Export failed: ${err.message}`, 'error');
    }
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function updateConnectionStatus(connected) {
    const el  = document.getElementById('connectionStatus');
    const txt = el.querySelector('.status-text');
    connected
        ? (el.classList.add('connected'),    txt.textContent = 'Connected')
        : (el.classList.remove('connected'), txt.textContent = 'Disconnected');
}

function showToast(message, type = 'info') {
    const t       = document.getElementById('toast');
    t.textContent = message;
    t.className   = `toast ${type} show`;
    setTimeout(() => t.classList.remove('show'), 3000);
}

window.EEGSystem = { state, CONFIG, sendMessage: sendWebSocketMessage, exportData };
console.log('💡 Debug: window.EEGSystem available');

function initLayoutControls() {
 
    /* ============================================================
   JS FIX — inside initLayoutControls(), replace the entire
   "── 1. Layout toggle pills ──" block with this version.

   The fix: side layout needs an explicit Plotly.Plots.resize
   call AFTER the browser has had time to reflow the flex row.
   The previous 370ms delay was enough for column layouts but
   the row reflow (which changes WIDTH not just height) needs
   the resize call to run after the new widths are computed.
   We also explicitly clear any drag-set inline styles so
   the CSS flex rules take full effect.
   ============================================================ */

    // ── 1. Layout toggle pills ────────────────────────────────────────────
    const container  = document.getElementById('dualPlotContainer');
    const layoutBtns = document.querySelectorAll('.layout-btn');

    layoutBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const layout = btn.dataset.layout;

            // Update active pill
            layoutBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Clear any inline heights set by the drag-resize handle
            // so that CSS flex/grid rules take full effect for the new layout
            const secOrig = document.getElementById('plotSectionOriginal');
            const secFilt = document.getElementById('plotSectionFiltered');
            secOrig.style.flex   = '';
            secOrig.style.height = '';
            secOrig.style.width  = '';
            secFilt.style.flex   = '';
            secFilt.style.height = '';
            secFilt.style.width  = '';

            // Apply layout attribute — triggers CSS rules
            container.setAttribute('data-layout', layout);

            // For side layout the browser must reflow a ROW which changes
            // element widths. We need two resize passes:
            //   Pass 1 (100ms): initial resize so Plotly fills the new space
            //   Pass 2 (400ms): after CSS transitions finish, final correct size
            const delays = layout === 'side' ? [100, 420] : [370];
            delays.forEach(delay => {
                setTimeout(() => {
                    ['plotContainerOriginal', 'plotContainerFiltered'].forEach(id => {
                        const el = document.getElementById(id);
                        if (el && el.style.display !== 'none') {
                            Plotly.Plots.resize(el);
                        }
                    });
                }, delay);
            });
        });
    });
 
 
    // ── 2. Draggable resize handle (split mode only) ──────────────────────
    const handle    = document.getElementById('resizeHandle');
    const secOrig   = document.getElementById('plotSectionOriginal');
    const secFilt   = document.getElementById('plotSectionFiltered');
 
    let isDragging  = false;
    let startY      = 0;
    let startOrigH  = 0;
    let startFiltH  = 0;
 
    handle.addEventListener('mousedown', (e) => {
        if (container.getAttribute('data-layout') !== 'split') return;
        isDragging  = true;
        startY      = e.clientY;
        startOrigH  = secOrig.getBoundingClientRect().height;
        startFiltH  = secFilt.getBoundingClientRect().height;
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
 
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const delta   = e.clientY - startY;
        const newOrig = Math.max(180, startOrigH + delta);
        const newFilt = Math.max(180, startFiltH - delta);
 
        // Apply as explicit pixel heights (overrides flex)
        secOrig.style.flex = 'none';
        secFilt.style.flex = 'none';
        secOrig.style.height = `${newOrig}px`;
        secFilt.style.height = `${newFilt}px`;
    });
 
    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
 
        // Resize Plotly after drag ends
        setTimeout(() => {
            ['plotContainerOriginal', 'plotContainerFiltered'].forEach(id => {
                const el = document.getElementById(id);
                if (el && el.style.display !== 'none') Plotly.Plots.resize(el);
            });
        }, 50);
    });
 
    // Touch support for resize handle
    handle.addEventListener('touchstart', (e) => {
        if (container.getAttribute('data-layout') !== 'split') return;
        isDragging  = true;
        startY      = e.touches[0].clientY;
        startOrigH  = secOrig.getBoundingClientRect().height;
        startFiltH  = secFilt.getBoundingClientRect().height;
        e.preventDefault();
    }, { passive: false });
 
    document.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const delta   = e.touches[0].clientY - startY;
        const newOrig = Math.max(180, startOrigH + delta);
        const newFilt = Math.max(180, startFiltH - delta);
        secOrig.style.flex = 'none';
        secFilt.style.flex = 'none';
        secOrig.style.height = `${newOrig}px`;
        secFilt.style.height = `${newFilt}px`;
    }, { passive: false });
 
    document.addEventListener('touchend', () => {
        if (!isDragging) return;
        isDragging = false;
        setTimeout(() => {
            ['plotContainerOriginal', 'plotContainerFiltered'].forEach(id => {
                const el = document.getElementById(id);
                if (el && el.style.display !== 'none') Plotly.Plots.resize(el);
            });
        }, 50);
    });
 
    // Reset explicit heights when layout mode changes
    // (so CSS flex takes over again)
    layoutBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            secOrig.style.flex   = '';
            secOrig.style.height = '';
            secFilt.style.flex   = '';
            secFilt.style.height = '';
        });
    });
 
 
    // ── 3. Expand / fullscreen button per plot ────────────────────────────
    function setupExpandBtn(btnId, sectionId, otherId) {
        const btn     = document.getElementById(btnId);
        const section = document.getElementById(sectionId);
        const other   = document.getElementById(otherId);
 
        if (!btn || !section) return;
 
        btn.addEventListener('click', () => {
            const isExpanded = section.classList.contains('is-expanded');
 
            if (isExpanded) {
                // Collapse back
                section.classList.remove('is-expanded');
                other.classList.remove('is-hidden-by-expand');
                btn.title = 'Expand';
                // Restore expand icon
                btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M2 2h4M2 2v4M13 2h-4M13 2v4M2 13h4M2 13v-4M13 13h-4M13 13v-4"/>
                </svg>`;
            } else {
                // Expand this section
                section.classList.add('is-expanded');
                other.classList.add('is-hidden-by-expand');
                btn.title = 'Collapse';
                // Switch to collapse icon
                btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M6 2v4H2M13 6H9V2M6 13v-4H2M9 13v-4h4"/>
                </svg>`;
            }
 
            // Resize Plotly after expand/collapse transition
            setTimeout(() => {
                const plotId = sectionId === 'plotSectionOriginal'
                    ? 'plotContainerOriginal'
                    : 'plotContainerFiltered';
                const el = document.getElementById(plotId);
                if (el && el.style.display !== 'none') Plotly.Plots.resize(el);
            }, 50);
        });
    }
 
    setupExpandBtn('btnExpandOriginal', 'plotSectionOriginal', 'plotSectionFiltered');
    setupExpandBtn('btnExpandFiltered', 'plotSectionFiltered', 'plotSectionOriginal');
 
 
    // ── 4. ESC key collapses any expanded section ─────────────────────────
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        ['plotSectionOriginal', 'plotSectionFiltered'].forEach(id => {
            const sec = document.getElementById(id);
            if (sec && sec.classList.contains('is-expanded')) {
                sec.classList.remove('is-expanded');
                // Unhide the other
                ['plotSectionOriginal', 'plotSectionFiltered']
                    .filter(x => x !== id)
                    .forEach(othId => {
                        document.getElementById(othId)
                            ?.classList.remove('is-hidden-by-expand');
                    });
                // Reset expand buttons
                ['btnExpandOriginal', 'btnExpandFiltered'].forEach(bid => {
                    const b = document.getElementById(bid);
                    if (b) {
                        b.title = 'Expand';
                        b.innerHTML = `<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.8">
                            <path d="M2 2h4M2 2v4M13 2h-4M13 2v4M2 13h4M2 13v-4M13 13h-4M13 13v-4"/>
                        </svg>`;
                    }
                });
                // Resize both
                setTimeout(() => {
                    ['plotContainerOriginal', 'plotContainerFiltered'].forEach(pid => {
                        const el = document.getElementById(pid);
                        if (el && el.style.display !== 'none') Plotly.Plots.resize(el);
                    });
                }, 50);
            }
        });
    });
 
    console.log('✅ Layout controls ready: toggle | drag-resize | expand | ESC');
}
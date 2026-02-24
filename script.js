/**
 * EEG Acquisition System - Frontend Application
 * FastAPI WebSocket Client Implementation
 */

// Configuration
const CONFIG = {
    API_URL: 'http://localhost:8000',
    WS_URL: 'ws://localhost:8000/ws',
    CHUNK_DURATION: 0.5,
    MAX_RECONNECT_ATTEMPTS: 5,
    RECONNECT_DELAY: 3000
};

// Application State
const state = {
    websocket: null,
    isConnected: false,
    reconnectAttempts: 0,
    eegData: {
        channels: [],
        channelNames: [],
        timeData: [],
        maxPoints: 2500,
        samplingRate: 250,
        isStreaming: false
    },
    plotConfig: {
        amplitudeScale: 5,
        timeWindow: 10,
        maxAmplitude: 200
    },
    fileInfo: null
};

// ===== Initialization =====
document.addEventListener('DOMContentLoaded', () => {
    console.log('🧠 EEG Acquisition System Initializing...');
    
    // Hide loading screen
    setTimeout(() => {
        const loadingScreen = document.getElementById('loadingScreen');
        loadingScreen.classList.add('hidden');
    }, 1500);
    
    // Initialize WebSocket
    initializeWebSocket();
    
    // Setup event listeners
    setupEventListeners();
    
    // Setup drag and drop
    setupDragAndDrop();
    
    console.log('✅ System Ready');
});

// ===== WebSocket Management =====
function initializeWebSocket() {
    console.log('🔌 Connecting to WebSocket...');
    
    try {
        state.websocket = new WebSocket(CONFIG.WS_URL);
        
        state.websocket.onopen = handleWebSocketOpen;
        state.websocket.onmessage = handleWebSocketMessage;
        state.websocket.onerror = handleWebSocketError;
        state.websocket.onclose = handleWebSocketClose;
        
    } catch (error) {
        console.error('WebSocket connection error:', error);
        showToast('Failed to connect to server', 'error');
    }
}

function handleWebSocketOpen() {
    console.log('✅ WebSocket Connected');
    state.isConnected = true;
    state.reconnectAttempts = 0;
    updateConnectionStatus(true);
    showToast('Connected to server', 'success');
}

function handleWebSocketMessage(event) {
    try {
        const message = JSON.parse(event.data);
        const { type } = message;
        
        switch (type) {
            case 'connection':
                console.log('Connection confirmed:', message.status);
                break;
            
            case 'eeg_data':
                handleEEGData(message.data);
                break;
            
            case 'stream_status':
                handleStreamStatus(message.status);
                break;
            
            case 'filter_status':
                handleFilterStatus(message);
                break;
            
            case 'error':
                showToast(message.message, 'error');
                break;
            
            default:
                console.warn('Unknown message type:', type);
        }
    } catch (error) {
        console.error('Error parsing WebSocket message:', error);
    }
}

function handleWebSocketError(error) {
    console.error('WebSocket error:', error);
    updateConnectionStatus(false);
}

function handleWebSocketClose() {
    console.log('🔌 WebSocket Disconnected');
    state.isConnected = false;
    updateConnectionStatus(false);
    
    // Attempt reconnection
    if (state.reconnectAttempts < CONFIG.MAX_RECONNECT_ATTEMPTS) {
        state.reconnectAttempts++;
        console.log(`Reconnecting... Attempt ${state.reconnectAttempts}`);
        showToast(`Reconnecting... (${state.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS})`, 'warning');
        
        setTimeout(() => {
            initializeWebSocket();
        }, CONFIG.RECONNECT_DELAY);
    } else {
        showToast('Connection lost. Please refresh the page.', 'error');
    }
}

function sendWebSocketMessage(data) {
    if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
        state.websocket.send(JSON.stringify(data));
    } else {
        console.error('WebSocket is not connected');
        showToast('Not connected to server', 'error');
    }
}

// ===== Event Listeners Setup =====
function setupEventListeners() {
    // File upload
    document.getElementById('fileInput').addEventListener('change', handleFileSelect);
    
    // Playback controls
    document.getElementById('btnStart').addEventListener('click', startStreaming);
    document.getElementById('btnPause').addEventListener('click', pauseStreaming);
    document.getElementById('btnStop').addEventListener('click', stopStreaming);
    
    // Filter controls
    document.getElementById('btnApplyFilters').addEventListener('click', applyFilters);
    
    // Display settings
    document.getElementById('selectAmplitude').addEventListener('change', updateDisplaySettings);
    document.getElementById('selectTimeWindow').addEventListener('change', updateDisplaySettings);
}

// ===== Drag and Drop =====
function setupDragAndDrop() {
    const uploadZone = document.getElementById('uploadZone');
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadZone.addEventListener(eventName, preventDefaults, false);
    });
    
    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    
    ['dragenter', 'dragover'].forEach(eventName => {
        uploadZone.addEventListener(eventName, () => {
            uploadZone.classList.add('dragging');
        });
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        uploadZone.addEventListener(eventName, () => {
            uploadZone.classList.remove('dragging');
        });
    });
    
    uploadZone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            uploadFile(files[0]);
        }
    });
}

// ===== File Upload =====
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        uploadFile(file);
    }
}

async function uploadFile(file) {
    if (!file.name.endsWith('.edf')) {
        showToast('Please select a valid .edf file', 'error');
        return;
    }
    
    console.log('📤 Uploading file:', file.name);
    showToast('Uploading file...', 'info');
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        const response = await fetch(`${CONFIG.API_URL}/api/upload`, {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            throw new Error(`Upload failed: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (data.success) {
            handleFileUploadSuccess(data);
            showToast('File loaded successfully!', 'success');
        } else {
            showToast('Failed to process file', 'error');
        }
        
    } catch (error) {
        console.error('Upload error:', error);
        showToast(`Upload failed: ${error.message}`, 'error');
    }
}

function handleFileUploadSuccess(data) {
    console.log('✅ File processed:', data);
    
    // Store file info
    state.fileInfo = data;
    
    // Update metadata display
    document.getElementById('fileMetadata').style.display = 'block';
    document.getElementById('metaFilename').textContent = data.filename;
    document.getElementById('metaChannels').textContent = data.n_channels;
    document.getElementById('metaSamplingRate').textContent = `${data.sampling_rate} Hz`;
    document.getElementById('metaDuration').textContent = `${data.duration.toFixed(2)} s`;
    document.getElementById('metaSamples').textContent = data.n_samples.toLocaleString();
    
    // Initialize EEG data structure
    state.eegData.channelNames = data.channels;
    state.eegData.samplingRate = data.sampling_rate;
    state.eegData.channels = new Array(data.n_channels).fill(null).map(() => []);
    state.eegData.timeData = [];
    
    // Update max points
    updateMaxPoints();
    
    // Initialize plot
    initializePlot();
    
    // Enable controls
    document.getElementById('btnStart').disabled = false;
    
    console.log('📊 Ready for visualization');
}

// ===== Streaming Controls =====
function startStreaming() {
    console.log('▶️ Starting stream');
    sendWebSocketMessage({ type: 'start_stream' });
    
    document.getElementById('btnStart').disabled = true;
    document.getElementById('btnPause').disabled = false;
    document.getElementById('btnStop').disabled = false;
}

function pauseStreaming() {
    console.log('⏸️ Pausing stream');
    sendWebSocketMessage({ type: 'pause_stream' });
    
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnPause').disabled = true;
}

function stopStreaming() {
    console.log('⏹️ Stopping stream');
    sendWebSocketMessage({ type: 'stop_stream' });
    
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnPause').disabled = true;
    document.getElementById('btnStop').disabled = true;
    
    // Reset data
    state.eegData.channels = state.eegData.channels.map(() => []);
    state.eegData.timeData = [];
}

function handleStreamStatus(status) {
    console.log('Stream status:', status);
    
    const indicator = document.getElementById('streamIndicator');
    const indicatorText = indicator.querySelector('.indicator-text');
    
    indicator.classList.remove('streaming');
    
    if (status === 'started') {
        indicator.classList.add('streaming');
        indicatorText.textContent = 'Streaming';
        state.eegData.isStreaming = true;
    } else if (status === 'paused') {
        indicatorText.textContent = 'Paused';
        state.eegData.isStreaming = false;
    } else if (status === 'stopped') {
        indicatorText.textContent = 'Idle';
        state.eegData.isStreaming = false;
    }
}

// ===== Filter Application =====
function applyFilters() {
    console.log('🎚️ Applying filters');
    
    const filters = [];
    
    // High-Pass Filter
    if (document.getElementById('filterHighpass').checked) {
        const cutoff = parseFloat(document.getElementById('inputHighpass').value);
        if (cutoff > 0) {
            sendWebSocketMessage({
                type: 'update_filter',
                filter_type: 'highpass',
                cutoff: cutoff
            });
            filters.push(`HPF: ${cutoff} Hz`);
        }
    } else {
        sendWebSocketMessage({
            type: 'update_filter',
            filter_type: 'highpass',
            cutoff: 0
        });
    }
    
    // Low-Pass Filter
    if (document.getElementById('filterLowpass').checked) {
        const cutoff = parseFloat(document.getElementById('inputLowpass').value);
        if (cutoff > 0) {
            sendWebSocketMessage({
                type: 'update_filter',
                filter_type: 'lowpass',
                cutoff: cutoff
            });
            filters.push(`LPF: ${cutoff} Hz`);
        }
    } else {
        sendWebSocketMessage({
            type: 'update_filter',
            filter_type: 'lowpass',
            cutoff: 0
        });
    }
    
    // Notch Filter
    if (document.getElementById('filterNotch').checked) {
        const notchFreq = parseFloat(document.getElementById('selectNotch').value);
        sendWebSocketMessage({
            type: 'update_filter',
            filter_type: 'notch',
            notch_freq: notchFreq,
            enabled: true
        });
        filters.push(`Notch: ${notchFreq} Hz`);
    } else {
        sendWebSocketMessage({
            type: 'update_filter',
            filter_type: 'notch',
            enabled: false
        });
    }
    
    updateActiveFiltersDisplay(filters);
}

function handleFilterStatus(message) {
    const { filter, status } = message;
    
    if (status === 'applied') {
        showToast(`${filter} filter applied`, 'success');
    } else if (status === 'removed') {
        showToast(`${filter} filter removed`, 'info');
    }
}

function updateActiveFiltersDisplay(filters) {
    const container = document.getElementById('activeFiltersDisplay');
    
    if (filters.length === 0) {
        container.innerHTML = '<p class="no-filters-text">No filters applied</p>';
    } else {
        container.innerHTML = filters.map(f => 
            `<span class="filter-tag">${f}</span>`
        ).join('');
    }
}

// ===== Display Settings =====
function updateDisplaySettings() {
    state.plotConfig.amplitudeScale = parseFloat(document.getElementById('selectAmplitude').value);
    state.plotConfig.timeWindow = parseFloat(document.getElementById('selectTimeWindow').value);
    
    updateMaxPoints();
    
    if (state.eegData.channelNames.length > 0) {
        updatePlotLayout();
    }
}

function updateMaxPoints() {
    state.eegData.maxPoints = Math.floor(
        state.plotConfig.timeWindow * state.eegData.samplingRate
    );
}

// ===== EEG Data Handling =====
function handleEEGData(data) {
    const { channels, timestamp } = data;
    
    // Update time display
    const timeValue = document.querySelector('.time-value');
    timeValue.textContent = `${timestamp.toFixed(2)}s`;
    
    // Process data
    for (let i = 0; i < channels.length; i++) {
        const channelData = channels[i];
        
        for (let j = 0; j < channelData.length; j++) {
            state.eegData.channels[i].push(channelData[j]); 
            
            if (i === 0) {
                state.eegData.timeData.push(
                    timestamp + (j / state.eegData.samplingRate)
                );
            }
        }
        
        // Keep only latest points
        if (state.eegData.channels[i].length > state.eegData.maxPoints) {
            state.eegData.channels[i] = state.eegData.channels[i].slice(
                -state.eegData.maxPoints
            );
        }
    }
    
    // Sync time data
    if (state.eegData.timeData.length > state.eegData.maxPoints) {
        state.eegData.timeData = state.eegData.timeData.slice(
            -state.eegData.maxPoints
        );
    }
    
    // Update plot
    updatePlot();
}

// ===== Plotting Functions =====
function initializePlot() {
    console.log('📊 Initializing plot');
    
    // Hide placeholder, show plot
    document.getElementById('plotPlaceholder').style.display = 'none';
    document.getElementById('plotContainer').style.display = 'block';
    
    const traces = [];
    const nChannels = state.eegData.channelNames.length;
    
    for (let i = 0; i < nChannels; i++) {
        traces.push({
            x: [],
            y: [],
            type: 'scatter',
            mode: 'lines',
            name: state.eegData.channelNames[i],
            line: {
                color: getChannelColor(i),
                width: 1.5
            }
        });
    }
    
    const layout = {
        title: {
            text: 'EEG Signal Visualization',
            font: { color: '#f1f5f9', size: 18 }
        },
        paper_bgcolor: '#1e293b',
        plot_bgcolor: '#0f172a',
        font: { color: '#cbd5e1' },
        xaxis: {
            title: 'Time (seconds)',
            gridcolor: '#334155',
            color: '#cbd5e1'
        },
        yaxis: {
            title: 'Amplitude (μV)',
            gridcolor: '#334155',
            color: '#cbd5e1',
            range: calculateYAxisRange()
        },
        showlegend: true,
        legend: {
            orientation: 'h',
            y: -0.15,
            font: { color: '#cbd5e1' }
        },
        margin: { t: 60, r: 50, b: 80, l: 80 },
        hovermode: 'closest'
    };
    
    const config = {
        responsive: true,
        displayModeBar: true,
        displaylogo: false,
        modeBarButtonsToRemove: ['lasso2d', 'select2d']
    };
    
    Plotly.newPlot('plotContainer', traces, layout, config); 
    console.log('✅ Plot initialized');
}

function updatePlot() {
    if (!document.getElementById('plotContainer') || 
        document.getElementById('plotContainer').style.display === 'none') {
        return;
    }
    
    const updates = { x: [], y: [] };
    const nChannels = state.eegData.channels.length;
    const spacing = calculateChannelSpacing();
    
    for (let i = 0; i < nChannels; i++) {
        updates.x.push(state.eegData.timeData);
        
        // Add vertical offset for each channel
        const offset = (nChannels - 1 - i) * spacing;
        const offsetData = state.eegData.channels[i].map(val => val + offset);
        updates.y.push(offsetData);
    }
    
    const traceIndices = Array.from({ length: nChannels }, (_, i) => i);
    Plotly.update('plotContainer', updates, {}, traceIndices);
}

function updatePlotLayout() {
    if (!document.getElementById('plotContainer') || 
        document.getElementById('plotContainer').style.display === 'none') {
        return;
    }
    
    Plotly.relayout('plotContainer', {
        'yaxis.range': calculateYAxisRange()
    });
}

function calculateChannelSpacing() {
    const nChannels = state.eegData.channelNames.length;
    if (nChannels <= 1) return 0;
    return state.plotConfig.amplitudeScale * 4;
}

function calculateYAxisRange() {
    const nChannels = state.eegData.channelNames.length;
    const spacing = calculateChannelSpacing();
    const totalRange = spacing * (nChannels - 1) + state.plotConfig.maxAmplitude;
    
    return [-state.plotConfig.maxAmplitude / 2, totalRange];
}

function getChannelColor(index) {
    const colors = [
        '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b',
        '#10b981', '#06b6d4', '#6366f1', '#a855f7'
    ];
    return colors[index % colors.length];
}

// ===== UI Helper Functions =====
function updateConnectionStatus(connected) {
    const statusIndicator = document.getElementById('connectionStatus');
    const statusText = statusIndicator.querySelector('.status-text');
    
    if (connected) {
        statusIndicator.classList.add('connected');
        statusText.textContent = 'Connected';
    } else {
        statusIndicator.classList.remove('connected');
        statusText.textContent = 'Disconnected';
    }
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// ===== Export for debugging =====
window.EEGSystem = {
    state,
    CONFIG,
    sendMessage: sendWebSocketMessage
};

console.log('💡 Debug: window.EEGSystem available'); 
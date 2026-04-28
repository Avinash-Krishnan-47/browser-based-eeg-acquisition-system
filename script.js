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
    usbMode: false,
    eegData: {
        original: {
            channels: [],
            timeData: []
        },
        filtered: {
            channels: [],
            timeData: []
        },
        channelNames: [],
        maxPoints: 2500,
        samplingRate: 250,
        isStreaming: false,
        hasFilteredData: false
    },
    plotConfig: {
        amplitudeScale: 20,
        timeWindow: 10,
        baselineSpacing: 100  // Spacing between channel baselines in μV
    },
    channelVisibility: [],  // Track visibility for each channel
    fileInfo: null
};

// ===== Initialization =====
document.addEventListener('DOMContentLoaded', () => {
    console.log('🧠 EEG Acquisition System Initializing...');
    
    setTimeout(() => {
        document.getElementById('loadingScreen').classList.add('hidden');
    }, 1500);
    
    initializeWebSocket();
    setupEventListeners();
    setupDragAndDrop();
    loadSerialPorts();
    
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
                handleStreamStatus(message.status, message.mode);
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

// ===== USB Functions =====
async function loadSerialPorts() {
    try {
        const response = await fetch(`${CONFIG.API_URL}/api/serial-ports`);
        const data = await response.json();
        
        const select = document.getElementById('selectSerialPort');
        select.innerHTML = '<option value="">Select Port...</option>';
        
        data.ports.forEach(port => {
            const option = document.createElement('option');
            option.value = port.device;
            option.textContent = `${port.device} - ${port.description}`;
            select.appendChild(option);
        });
        
        console.log(`Found ${data.ports.length} serial ports`);
        
    } catch (error) {
        console.error('Error loading serial ports:', error);
    }
}

async function connectUSB() {
    const port = document.getElementById('selectSerialPort').value;
    const baudrate = parseInt(document.getElementById('selectBaudRate').value);
    const n_channels = parseInt(document.getElementById('inputChannels').value);
    const sampling_rate = parseInt(document.getElementById('inputSamplingRate').value);
    
    if (!port) {
        showToast('Please select a serial port', 'warning');
        return;
    }
    
    console.log('🔌 Connecting to USB...', {port, baudrate, n_channels, sampling_rate});
    showToast('Connecting to USB device...', 'info');
    
    try {
        const response = await fetch(`${CONFIG.API_URL}/api/usb/connect`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({port, baudrate, n_channels, sampling_rate})
        });
        
        const data = await response.json();
        
        if (data.success) {
            state.usbMode = true;
            state.eegData.channelNames = Array.from({length: n_channels}, (_, i) => `CH${i+1}`);
            state.eegData.samplingRate = sampling_rate;
            state.eegData.original.channels = new Array(n_channels).fill(null).map(() => []);
            state.eegData.filtered.channels = new Array(n_channels).fill(null).map(() => []);
            state.channelVisibility = new Array(n_channels).fill(true);
            
            updateMaxPoints();
            initializePlots();
            
            document.getElementById('usbStatus').innerHTML = '<div class="status-badge usb-connected">Connected</div>';
            document.getElementById('btnUSBConnect').style.display = 'none';
            document.getElementById('btnUSBDisconnect').style.display = 'block';
            document.getElementById('btnStart').disabled = false;
            
            showToast('USB device connected!', 'success');
        }
        
    } catch (error) {
        console.error('USB connection error:', error);
        showToast('Failed to connect USB device', 'error');
    }
}

async function disconnectUSB() {
    try {
        await fetch(`${CONFIG.API_URL}/api/usb/disconnect`, {method: 'POST'});
        
        state.usbMode = false;
        document.getElementById('usbStatus').innerHTML = '<div class="status-badge usb-disconnected">Disconnected</div>';
        document.getElementById('btnUSBConnect').style.display = 'block';
        document.getElementById('btnUSBDisconnect').style.display = 'none';
        
        showToast('USB device disconnected', 'info');
        
    } catch (error) {
        console.error('USB disconnection error:', error);
    }
}

// ===== Event Listeners Setup =====
function setupEventListeners() {
    document.getElementById('fileInput').addEventListener('change', handleFileSelect);
    
    document.getElementById('btnStart').addEventListener('click', startStreaming);
    document.getElementById('btnPause').addEventListener('click', pauseStreaming);
    document.getElementById('btnStop').addEventListener('click', stopStreaming);
    
    document.getElementById('btnApplyFilters').addEventListener('click', applyFilters);
    
    // CHANGE 5: Manual input for display settings
    document.getElementById('inputAmplitude').addEventListener('change', updateDisplaySettings);
    document.getElementById('inputTimeWindow').addEventListener('change', updateDisplaySettings);
    document.getElementById('inputAmplitude').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') updateDisplaySettings();
    });
    document.getElementById('inputTimeWindow').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') updateDisplaySettings();
    });
    
    document.getElementById('btnExportCSV').addEventListener('click', () => exportData('csv'));
    document.getElementById('btnExportEDF').addEventListener('click', () => exportData('edf'));
    
    // USB controls
    document.getElementById('btnRefreshPorts').addEventListener('click', loadSerialPorts);
    document.getElementById('btnUSBConnect').addEventListener('click', connectUSB);
    document.getElementById('btnUSBDisconnect').addEventListener('click', disconnectUSB);
}

// ===== Drag and Drop =====
function setupDragAndDrop() {
    const uploadZone = document.getElementById('uploadZone');
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
    });
    
    ['dragenter', 'dragover'].forEach(eventName => {
        uploadZone.addEventListener(eventName, () => uploadZone.classList.add('dragging'));
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        uploadZone.addEventListener(eventName, () => uploadZone.classList.remove('dragging'));
    });
    
    uploadZone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length > 0) uploadFile(files[0]);
    });
}

// ===== File Upload =====
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) uploadFile(file);
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
        
        const data = await response.json();
        
        if (data.success) {
            state.usbMode = false;
            state.fileInfo = data;
            
            document.getElementById('fileMetadata').style.display = 'block';
            document.getElementById('metaFilename').textContent = data.original_filename || data.filename;
            document.getElementById('metaChannels').textContent = data.n_channels;
            document.getElementById('metaSamplingRate').textContent = `${data.sampling_rate} Hz`;
            document.getElementById('metaDuration').textContent = `${data.duration.toFixed(2)} s`;
            document.getElementById('metaSamples').textContent = data.n_samples.toLocaleString();
            
            state.eegData.channelNames = data.channels;
            state.eegData.samplingRate = data.sampling_rate;
            state.eegData.original.channels = new Array(data.n_channels).fill(null).map(() => []);
            state.eegData.filtered.channels = new Array(data.n_channels).fill(null).map(() => []);
            state.eegData.hasFilteredData = false;
            state.channelVisibility = new Array(data.n_channels).fill(true);
            
            updateMaxPoints();
            initializePlots();
            
            document.getElementById('btnStart').disabled = false;
            updateExportStatus();
            
            showToast('File loaded successfully!', 'success');
        }
        
    } catch (error) {
        console.error('Upload error:', error);
        showToast(`Upload failed: ${error.message}`, 'error');
    }
}

// ===== Streaming Controls =====
function startStreaming() {
    console.log('▶️ Starting stream', state.usbMode ? '(USB MODE)' : '(FILE MODE)');
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
}

function handleStreamStatus(status, mode) {
    console.log('Stream status:', status, mode || '');
    
    const indicator = document.getElementById('streamIndicator');
    const indicatorText = indicator.querySelector('.indicator-text');
    
    indicator.classList.remove('streaming');
    
    if (status === 'started') {
        indicator.classList.add('streaming');
        indicatorText.textContent = mode === 'usb' ? 'USB Streaming' : 'Streaming';
        state.eegData.isStreaming = true;
    } else if (status === 'paused') {
        indicatorText.textContent = 'Paused';
        state.eegData.isStreaming = false;
    } else if (status === 'stopped') {
        indicatorText.textContent = 'Idle';
        state.eegData.isStreaming = false;
        
        if (state.eegData.hasFilteredData) {
            updateExportStatus();
        }
    }
}

// ===== Filter Application =====
function applyFilters() {
    console.log('🎚️ Applying filters');
    
    const filters = [];
    
    // High-pass filter
    if (document.getElementById('filterHighpass').checked) {
        const cutoff = parseFloat(document.getElementById('inputHighpass').value);
        const filterType = document.getElementById('selectHighpassType').value;
        
        if (cutoff > 0) {
            sendWebSocketMessage({
                type: 'update_filter', 
                filter_type: 'highpass', 
                cutoff: cutoff,
                filter_design: filterType
            });
            
            const filterTypeName = getFilterTypeName(filterType);
            filters.push(`HPF: ${cutoff} Hz (${filterTypeName})`);
        }
    } else {
        sendWebSocketMessage({type: 'update_filter', filter_type: 'highpass', cutoff: 0});
    }
    
    // Low-pass filter
    if (document.getElementById('filterLowpass').checked) {
        const cutoff = parseFloat(document.getElementById('inputLowpass').value);
        const filterType = document.getElementById('selectLowpassType').value;
        
        if (cutoff > 0) {
            sendWebSocketMessage({
                type: 'update_filter', 
                filter_type: 'lowpass', 
                cutoff: cutoff,
                filter_design: filterType
            });
            
            const filterTypeName = getFilterTypeName(filterType);
            filters.push(`LPF: ${cutoff} Hz (${filterTypeName})`);
        }
    } else {
        sendWebSocketMessage({type: 'update_filter', filter_type: 'lowpass', cutoff: 0});
    }
    
    // Notch filter
    if (document.getElementById('filterNotch').checked) {
        const notchFreq = parseFloat(document.getElementById('selectNotch').value);
        sendWebSocketMessage({type: 'update_filter', filter_type: 'notch', notch_freq: notchFreq, enabled: true});
        filters.push(`Notch: ${notchFreq} Hz`);
    } else {
        sendWebSocketMessage({type: 'update_filter', filter_type: 'notch', enabled: false});
    }
    
    updateActiveFiltersDisplay(filters);
}

function getFilterTypeName(filterType) {
    const filterNames = {
        'butterworth': 'Butterworth',
        'chebyshev1': 'Chebyshev I',
        'chebyshev2': 'Chebyshev II',
        'elliptic': 'Elliptic'
    };
    return filterNames[filterType] || filterType;
}

function handleFilterStatus(message) {
    const { filter, status, design } = message;
    
    if (status === 'applied') {
        const designName = design ? ` (${getFilterTypeName(design)})` : '';
        showToast(`${filter} filter applied${designName}`, 'success');
    } else if (status === 'removed') {
        showToast(`${filter} filter removed`, 'info');
    }
}

function updateActiveFiltersDisplay(filters) {
    const container = document.getElementById('activeFiltersDisplay');
    
    if (filters.length === 0) {
        container.innerHTML = '<p class="no-filters-text">No filters applied</p>';
    } else {
        container.innerHTML = filters.map(f => `<span class="filter-tag">${f}</span>`).join('');
    }
}

// ===== Display Settings - CHANGE 5: Manual Input =====
function updateDisplaySettings() {
    const ampValue = parseFloat(document.getElementById('inputAmplitude').value);
    const timeValue = parseFloat(document.getElementById('inputTimeWindow').value);
    
    if (!isNaN(ampValue) && ampValue > 0) {
        state.plotConfig.amplitudeScale = ampValue;
        state.plotConfig.baselineSpacing = ampValue * 5;
    }
    
    if (!isNaN(timeValue) && timeValue > 0) {
        state.plotConfig.timeWindow = timeValue;
    }
    
    updateMaxPoints();
    
    if (state.eegData.channelNames.length > 0) {
        updatePlotLayouts();
        showToast(`Display updated: ${state.plotConfig.amplitudeScale}μV, ${state.plotConfig.timeWindow}s`, 'success');
    }
}

function updateMaxPoints() {
    state.eegData.maxPoints = Math.floor(state.plotConfig.timeWindow * state.eegData.samplingRate);
}

// ===== EEG Data Handling =====
function handleEEGData(data) {
    const { original, filtered, timestamp } = data;
    
    document.querySelector('.time-value').textContent = `${timestamp.toFixed(2)}s`;
    
    // Process original data
    for (let i = 0; i < original.length; i++) {
        const channelData = original[i];
        
        for (let j = 0; j < channelData.length; j++) {
            state.eegData.original.channels[i].push(channelData[j]);
            
            if (i === 0) {
                state.eegData.original.timeData.push(timestamp + (j / state.eegData.samplingRate));
            }
        }
        
        if (state.eegData.original.channels[i].length > state.eegData.maxPoints) {
            state.eegData.original.channels[i] = state.eegData.original.channels[i].slice(-state.eegData.maxPoints);
        }
    }
    
    // Process filtered data
    for (let i = 0; i < filtered.length; i++) {
        const channelData = filtered[i];
        
        for (let j = 0; j < channelData.length; j++) {
            state.eegData.filtered.channels[i].push(channelData[j]);
            
            if (i === 0) {
                state.eegData.filtered.timeData.push(timestamp + (j / state.eegData.samplingRate));
            }
        }
        
        if (state.eegData.filtered.channels[i].length > state.eegData.maxPoints) {
            state.eegData.filtered.channels[i] = state.eegData.filtered.channels[i].slice(-state.eegData.maxPoints);
        }
    }
    
    // Sync time data
    if (state.eegData.original.timeData.length > state.eegData.maxPoints) {
        state.eegData.original.timeData = state.eegData.original.timeData.slice(-state.eegData.maxPoints);
    }
    
    if (state.eegData.filtered.timeData.length > state.eegData.maxPoints) {
        state.eegData.filtered.timeData = state.eegData.filtered.timeData.slice(-state.eegData.maxPoints);
    }
    
    state.eegData.hasFilteredData = true;
    updatePlots();
}

// ===== Plotting Functions =====
function initializePlots() {
    console.log('📊 Initializing plots');
    
    initializePlot('Original', 'plotPlaceholderOriginal', 'plotContainerOriginal');
    initializePlot('Filtered', 'plotPlaceholderFiltered', 'plotContainerFiltered');
    
    console.log('✅ Plots initialized');
}

function initializePlot(plotType, placeholderId, containerId) {
    document.getElementById(placeholderId).style.display = 'none';
    document.getElementById(containerId).style.display = 'block';
    
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
            },
            // CHANGE 2: Show legend on right for click toggle
            showlegend: true,
            // CHANGE 1: Store raw values in customdata for baseline-independent display
            customdata: [],
            hovertemplate: '<b>%{fullData.name}</b><br>Time: %{x:.3f}s<br>Value: %{customdata:.2f} μV<extra></extra>'
        });
    }
    
    const layout = {
        title: {text: `${plotType} EEG Signal`, font: {color: '#f1f5f9', size: 16}},
        paper_bgcolor: '#1e293b',
        plot_bgcolor: '#0f172a',
        font: {color: '#cbd5e1'},
        xaxis: {
            title: 'Time (seconds)', 
            gridcolor: '#334155', 
            color: '#cbd5e1',
            zeroline: false,
            // CHANGE 3: Enable crosshair
            showspikes: true,
            spikecolor: '#60a5fa',
            spikethickness: 1,
            spikedash: 'solid',
            spikemode: 'across'
        },
        yaxis: {
            title: 'Channel', 
            gridcolor: '#334155', 
            color: '#cbd5e1', 
            range: calculateYAxisRange(),
            tickmode: 'array',
            tickvals: getChannelTickPositions(),
            ticktext: getChannelTickLabels(),
            tickfont: {
                size: 11,
                color: '#cbd5e1',
                family: 'monospace'
            },
            zeroline: false,
            // CHANGE 3: Enable crosshair
            showspikes: true,
            spikecolor: '#60a5fa',
            spikethickness: 1,
            spikedash: 'solid',
            spikemode: 'across'
        },
        // CHANGE 4: Legend on right side
        showlegend: true,
        legend: {
            x: 1.02,
            y: 1,
            xanchor: 'left',
            yanchor: 'top',
            bgcolor: 'rgba(30, 41, 59, 0.9)',
            bordercolor: '#334155',
            borderwidth: 1,
            font: {
                size: 10,
                color: '#cbd5e1'
            }
        },
        margin: {t: 50, r: 150, b: 70, l: 100},
        // CHANGE 3: Unified hover mode with crosshair
        hovermode: 'x unified',
        hoverdistance: 50,
        spikedistance: -1,
        shapes: getBaselineShapes()
    };
    
    const config = {
        responsive: true,
        displayModeBar: true,
        displaylogo: false,
        modeBarButtonsToRemove: ['lasso2d', 'select2d']
    };
    
    Plotly.newPlot(containerId, traces, layout, config);
    
    // CHANGE 2: Handle legend click for toggling channels
    const plotDiv = document.getElementById(containerId);
    plotDiv.on('plotly_legendclick', function(data) {
        const curveNumber = data.curveNumber;
        state.channelVisibility[curveNumber] = !state.channelVisibility[curveNumber];
        
        // Sync visibility to other plot
        const otherPlot = containerId === 'plotContainerOriginal' ? 'plotContainerFiltered' : 'plotContainerOriginal';
        const otherDiv = document.getElementById(otherPlot);
        if (otherDiv && otherDiv.data) {
            Plotly.restyle(otherPlot, {visible: state.channelVisibility[curveNumber]}, [curveNumber]);
        }
        
        return true; // Allow default Plotly behavior
    });
}

function getChannelTickPositions() {
    const nChannels = state.eegData.channelNames.length;
    const positions = [];
    
    for (let i = 0; i < nChannels; i++) {
        // CHANGE 1: Each channel baseline at i * spacing
        const baseline = i * state.plotConfig.baselineSpacing;
        positions.push(baseline);
    }
    
    return positions;
}

function getChannelTickLabels() {
    return state.eegData.channelNames;
}

function getBaselineShapes() {
    const nChannels = state.eegData.channelNames.length;
    const shapes = [];
    
    for (let i = 0; i < nChannels; i++) {
        const baseline = i * state.plotConfig.baselineSpacing;
        shapes.push({
            type: 'line',
            x0: 0,
            x1: 1,
            xref: 'paper',
            y0: baseline,
            y1: baseline,
            yref: 'y',
            line: {
                color: '#475569',
                width: 1,
                dash: 'dot'
            }
        });
    }
    
    return shapes;
}

function updatePlots() {
    updatePlot('plotContainerOriginal', state.eegData.original);
    updatePlot('plotContainerFiltered', state.eegData.filtered);
}

function updatePlot(containerId, dataSource) {
    const container = document.getElementById(containerId);
    if (!container || container.style.display === 'none') return;
    
    const updates = {x: [], y: [], customdata: [], visible: []};
    const nChannels = dataSource.channels.length;
    
    for (let i = 0; i < nChannels; i++) {
        updates.x.push(dataSource.timeData);
        
        // CHANGE 1: Apply baseline offset for display
        const baseline = i * state.plotConfig.baselineSpacing;
        const offsetData = dataSource.channels[i].map(val => val + baseline);
        updates.y.push(offsetData);
        
        // Store raw values for hover display
        updates.customdata.push(dataSource.channels[i]);
        
        // Apply visibility
        updates.visible.push(state.channelVisibility[i]);
    }
    
    const traceIndices = Array.from({length: nChannels}, (_, i) => i);
    Plotly.update(containerId, updates, {}, traceIndices);
}

function updatePlotLayouts() {
    ['plotContainerOriginal', 'plotContainerFiltered'].forEach(containerId => {
        const container = document.getElementById(containerId);
        if (container && container.style.display !== 'none') {
            Plotly.relayout(containerId, {
                'yaxis.range': calculateYAxisRange(),
                'yaxis.tickvals': getChannelTickPositions(),
                'yaxis.ticktext': getChannelTickLabels(),
                'shapes': getBaselineShapes()
            });
        }
    });
}

function calculateYAxisRange() {
    const nChannels = state.eegData.channelNames.length;
    if (nChannels === 0) return [-100, 100];
    
    const totalHeight = (nChannels - 1) * state.plotConfig.baselineSpacing;
    const padding = state.plotConfig.amplitudeScale * 3;
    
    return [-padding, totalHeight + padding];
}

function getChannelColor(index) {
    const colors = [
        '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b',
        '#10b981', '#06b6d4', '#6366f1', '#a855f7',
        '#14b8a6', '#f43f5e', '#84cc16', '#fb923c'
    ];
    return colors[index % colors.length];
}

// ===== Export Functionality =====
function updateExportStatus() {
    const exportInfo = document.getElementById('exportInfo');
    const exportStatus = exportInfo.querySelector('.export-status');
    const btnExportCSV = document.getElementById('btnExportCSV');
    const btnExportEDF = document.getElementById('btnExportEDF');
    
    if (state.eegData.hasFilteredData && !state.eegData.isStreaming) {
        exportStatus.textContent = 'Filtered data ready for export';
        exportStatus.classList.add('ready');
        btnExportCSV.disabled = false;
        btnExportEDF.disabled = false;
    } else if (state.eegData.isStreaming) {
        exportStatus.textContent = 'Stop streaming to export';
        exportStatus.classList.remove('ready');
        btnExportCSV.disabled = true;
        btnExportEDF.disabled = true;
    } else {
        exportStatus.textContent = 'Stream data to enable export';
        exportStatus.classList.remove('ready');
        btnExportCSV.disabled = true;
        btnExportEDF.disabled = true;
    }
}

async function exportData(format) {
    console.log(`💾 Exporting data as ${format.toUpperCase()}`);
    showToast(`Exporting as ${format.toUpperCase()}...`, 'info');
    
    try {
        const response = await fetch(`${CONFIG.API_URL}/api/export?format=${format}`, {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast(`Exported ${data.samples_exported.toLocaleString()} samples to ${data.filename}`, 'success');
            
            const downloadUrl = `${CONFIG.API_URL}/api/download/${data.filename}`;
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.download = data.filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
        
    } catch (error) {
        console.error('Export error:', error);
        showToast(`Export failed: ${error.message}`, 'error');
    }
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

window.EEGSystem = {state, CONFIG, sendMessage: sendWebSocketMessage, exportData};
console.log('💡 Debug: window.EEGSystem available');
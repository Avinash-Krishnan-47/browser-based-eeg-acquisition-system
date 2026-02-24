import numpy as np
import mne

# Parameters
fs = 250
duration = 20
n_channels = 4
n_samples = fs * duration

t = np.linspace(0, duration, n_samples)

data = []

for ch in range(n_channels):
    alpha = 50e-6 * np.sin(2 * np.pi * 10 * t)  # 50 microvolts
    beta = 20e-6 * np.sin(2 * np.pi * 20 * t)   # 20 microvolts
    noise = 10e-6 * np.random.randn(n_samples) # 10 microvolts noise
    
    signal = alpha + beta + noise
    data.append(signal)

data = np.array(data)

ch_names = [f"EEG Ch{i+1}" for i in range(n_channels)]
info = mne.create_info(ch_names=ch_names, sfreq=fs, ch_types="eeg")

raw = mne.io.RawArray(data, info)

# Export with controlled physical range
raw.export(
    "sample_eeg.edf",
    fmt="edf",
    physical_range=(-100e-6, 100e-6)  # +/-100 microvolts
)

print("✅ sample_eeg.edf generated successfully!")
const path = require('path');
const os = require('os');

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

const Config = {
    // Path to the compiled exe (adjust this to where your EXE actually lives)
    exePath: path.join(__dirname, "backend", "transcription_engine.exe"),
    
    // Directory where models are stored
    modelDir: path.join(localAppData, "AutoCaps", "models"),
    
    // Directory where CUDA will be unzipped
    cudaDir: path.join(localAppData, "AutoCaps", "cuda"),
    
    // Temporary directory for audio exports and SRT outputs
    tempDir: os.tmpdir(),
    
    // Default model name as defined in your python script
    modelName: "ivrit-ai/whisper-large-v3-turbo-ct2"
};
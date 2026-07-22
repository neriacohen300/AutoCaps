const path = require('path');
const os = require('os');

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

const Config = {
    version: "1.0.7",

    // פרטי מאגר הגיטהאב לבדיקת עדכונים
    githubOwner: "neriacohen300",
    githubRepo: "AutoCaps",

    // Path to the compiled exe
    exePath: path.join(localAppData, "AutoCaps", "backend", "transcription_engine.exe"),
    
    // Directory where models are stored
    modelDir: path.join(localAppData, "AutoCaps", "models"),
    
    // Directory where CUDA will be unzipped
    cudaDir: path.join(localAppData, "AutoCaps", "cuda"),
    
    // Temporary directory for audio exports and SRT outputs
    tempDir: os.tmpdir(),
    
    // Default model name
    modelName: "ivrit-ai/whisper-large-v3-turbo-ct2",

    // נתיב קובץ ה-FFmpeg בשביל חיתוך השקט (יש לוודא שהוא אכן נמצא שם!)
    ffmpegPath: path.join(localAppData, "AutoCaps", "backend", "ffmpeg.exe"),
    
    // נתיב לקובץ ה-Preset (.epr) לצורך ייצוא אודיו לפרימייר (חובה כדי ש-exportAsMediaDirect יעבוד)
    presetPath: path.join(localAppData, "AutoCaps", "backend", "AudioExport.epr"),

    // נתיב לקובץ בו נשמר מילון המונחים המותאם אישית (Custom Vocabulary) של המשתמש
    vocabularyPath: path.join(localAppData, "AutoCaps", "vocabulary.json")
};
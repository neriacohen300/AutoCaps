const path = require('path');
const os = require('os');

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

const Config = {
    version: "1.0.3-ae",

    // פרטי מאגר הגיטהאב לבדיקת עדכונים
    githubOwner: "neriacohen300",
    githubRepo: "AutoCaps",

    // נשארים באותה תיקיית AppData\Local\AutoCaps ששימשה את גרסת פרימייר,
    // כדי לא לגרום למשתמש להוריד שוב את המודל / CUDA אם כבר התקין את הפאנל של פרימייר.
    exePath: path.join(localAppData, "AutoCaps", "backend", "transcription_engine.exe"),
    modelDir: path.join(localAppData, "AutoCaps", "models"),
    cudaDir: path.join(localAppData, "AutoCaps", "cuda"),
    tempDir: os.tmpdir(),
    modelName: "ivrit-ai/whisper-large-v3-turbo-ct2",
    ffmpegPath: path.join(localAppData, "AutoCaps", "backend", "ffmpeg.exe"),

    // ב-Premiere השתמשנו בקובץ .epr לייצוא אודיו. ב-After Effects אין exportAsMediaDirect —
    // הייצוא עובר דרך ה-Render Queue, שדורש "Output Module Template" בשם קבוע במקום קובץ preset.
    // התבנית הזו נטענת פעם אחת דרך AE (Edit > Templates > Output Module > Load...) בהתקנה,
    // ואז מזוהה בקוד לפי השם שלה בלבד.
    audioOutputModuleTemplate: "AutoCaps Audio Only (WAV)",
    audioOutputModuleTemplateFile: path.join(localAppData, "AutoCaps", "backend", "AutoCapsAudioOnly.aom"),

    vocabularyPath: path.join(localAppData, "AutoCaps", "vocabulary_ae.json")
};

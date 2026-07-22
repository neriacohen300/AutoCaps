AutoCaps for After Effects — one-time setup
=============================================

Premiere Pro's exportAsMediaDirect() can export audio straight from a .epr
preset file, so the Premiere version of AutoCaps just shipped that file.

After Effects has no equivalent API — audio export has to go through the
Render Queue, and AE's Render Queue only knows "Output Module Templates"
that already exist *inside* AE's own preferences. There is no supported way
to install one from outside the app (.aom files are a proprietary binary
format, not something to hand-author). So this one step has to be done once,
inside After Effects, before AutoCaps can export audio:

1. Open After Effects.
2. Menu: Edit > Templates > Output Module...
3. Click "New".
4. Set:
   - Format: WAV (or "Audio Only" if your AE build lists that name for WAV)
   - Under Audio Output, make sure the "Audio Output" checkbox is ON,
     any sample rate/bit depth is fine (16-bit / 48kHz is plenty for
     transcription — it doesn't need to be broadcast quality).
   - Make sure Video Output is OFF (uncheck it) — audio-only keeps
     the render fast.
5. Name the template exactly:
       AutoCaps Audio Only (WAV)
   (This name must match Config.audioOutputModuleTemplate in js/config.js
   exactly — if you rename it, update config.js to match.)
6. Click OK, then OK again to close the Templates dialog.

That's it — this only needs to be done once per machine. After that,
the "יצירת שכבת כתוביות בקומפוזיציה" button in the panel will render
audio silently in the background using this template.

If you ever see the error:
   "תבנית ה-Output Module ... לא מותקנת ב-After Effects"
it means this template is missing or was renamed — redo the steps above.

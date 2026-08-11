# pi-dictate

Minimal Deepgram push-to-talk dictation for Pi on macOS.

## Setup

```text
/login deepgram
```

Hold `Ctrl+Alt+D` to record. Release it to place the transcript in Pi's editor.

Pi stores the API key in `~/.pi/agent/auth.json` using its standard credential flow.

## Settings

Add optional settings under `dictate` in `~/.pi/agent/settings.json`:

```json
{
  "dictate": {
    "shortcut": "ctrl+alt+d",
    "language": "en"
  }
}
```

Restart Pi after changing these settings.

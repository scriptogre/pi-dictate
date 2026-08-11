# pi-dictate

Dictate into Pi with Deepgram.

## Install

1. Install ffmpeg:

   ```sh
   brew install ffmpeg
   ```

2. Install pi-dictate:

   ```sh
   pi install git:github.com/scriptogre/pi-dictate
   ```

3. Restart Pi and add your Deepgram API key:

   New accounts include [$200 in credit](https://deepgram.com/pricing). [Create an account](https://console.deepgram.com/signup).

   ```text
   /login deepgram
   ```

Pi stores the key through its standard credential flow. Allow microphone access when macOS asks.

## Dictate

Hold `Ctrl+Alt+D` while speaking.

Your words appear in Pi's editor as you talk.

## Configure

Create `~/.pi/agent/pi-dictate.json`, then restart Pi.

```json
{
  "shortcut": "ctrl+alt+d",
  "language": "en"
}
```

## Need more voice features?

[pi-listen](https://github.com/codexstar69/pi-listen) supports a broader set of voice features.

pi-dictate stays focused on Deepgram push-to-talk.

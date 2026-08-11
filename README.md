# pi-dictate

Lightweight Deepgram push-to-talk dictation for Pi on macOS.

## Install

Install `ffmpeg`, then install the Pi package:

```sh
brew install ffmpeg
pi install git:github.com/scriptogre/pi-dictate
```

Restart Pi and add your Deepgram API key:

```text
/login deepgram
```

Pi stores the key through its standard credential flow. Allow microphone access when macOS asks.

## Dictate

Hold `Ctrl+Alt+D` while speaking. Words appear in Pi's editor as you talk.

## Change the shortcut or language

Create `~/.pi/agent/config/pi-dictate.json`, then restart Pi:

```json
{
  "shortcut": "ctrl+alt+d",
  "language": "en"
}
```

## Why pi-dictate?

[pi-listen](https://github.com/codexstar69/pi-listen) supports a broader set of voice features. pi-dictate is a much smaller option for people who only need Deepgram push-to-talk.

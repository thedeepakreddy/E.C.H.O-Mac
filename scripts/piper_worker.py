"""Piper TTS worker for Echo (src/voice/tts-stream.ts, PiperTtsStream).

Loads one voice once, then speaks sentences for as long as it runs:

  stdin   one JSON object per line: {"id": <uint32>, "text": "...", "length_scale": <float, optional>}
  stdout  binary frames: <id uint32 LE> <byte length uint32 LE> <16-bit mono PCM>
          a frame with length 0 marks the end of that sentence's audio;
          id 0xFFFFFFFF with length 0 is sent once, when the voice is loaded.
"""
import json
import struct
import sys

from piper import PiperVoice, SynthesisConfig

READY = 0xFFFFFFFF


def frame(out, sid: int, data: bytes = b"") -> None:
    out.write(struct.pack("<II", sid, len(data)))
    if data:
        out.write(data)
    out.flush()


def main() -> None:
    voice = PiperVoice.load(sys.argv[1])
    out = sys.stdout.buffer
    frame(out, READY)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            sid = int(req["id"]) % READY
            text = str(req.get("text", "")).strip()
        except (ValueError, KeyError, TypeError) as err:
            print(f"piper_worker: bad request: {err}", file=sys.stderr, flush=True)
            continue
        try:
            if text:
                config = SynthesisConfig(length_scale=req.get("length_scale"))
                for chunk in voice.synthesize(text, syn_config=config):
                    frame(out, sid, chunk.audio_int16_bytes)
        except Exception as err:  # one bad sentence must not kill the voice
            print(f"piper_worker: synthesis failed: {err}", file=sys.stderr, flush=True)
        frame(out, sid)


if __name__ == "__main__":
    main()

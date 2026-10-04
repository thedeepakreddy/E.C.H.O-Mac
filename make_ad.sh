#!/bin/bash
cd "/Users/thedeepakreddy/J.A.R.V.I.S/Echo Mac/docs/media"

ffmpeg -y \
  -stream_loop 2 -i humanoid-open.mp4 \
  -i hud.mp4 \
  -stream_loop 3 -i control-panel.mp4 \
  -i voiceover.aiff \
  -filter_complex "[0:v]trim=duration=4.5,setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v0]; \
                   [1:v]setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v1]; \
                   [2:v]trim=duration=5,setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v2]; \
                   [v0][v1][v2]concat=n=3:v=1:a=0[vout]" \
  -map "[vout]" -map 3:a -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest final_ad.mp4

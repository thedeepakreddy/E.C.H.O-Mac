import os

appendix = """

## Comprehensive Capabilities & Advanced Engineering

Echo Mac is engineered to be a state-of-the-art, fully autonomous agentic wrapper for your operating system. It operates at the intersection of streaming multimodal AI and deep OS integration.

### How Advanced Is It Engineered?
- **Streaming Multimodal Pipeline**: Voice is processed via streaming Speech-to-Text (Sarvam, whisper.cpp, Apple) straight into LLM generative streams (Claude, Gemini, Ollama), which feed into an intelligent sentence chunker and instant Text-to-Speech (say, Sarvam, ElevenLabs).
- **Crash-Tolerant Replay Journal**: Every action, tool call, and provider exchange is written to a crash-tolerant tape. If a model halts or a tool times out, Echo can safely replay exact provider recordings and resume gracefully.
- **Dynamic Brain Switching**: Switch brains in real-time between Claude, Gemini, or Ollama just by saying their name. The system swaps the backend without dropping your UI or panels.
- **True Vision & Semantic Understanding**: Beyond simple pixels, Echo parses the macOS accessibility tree to click precise UI elements, uses fast on-device OCR as a fallback (`read_screen_text`), and can even index your local documents to search by *meaning*, not just keywords.
- **Local Autonomy & Privacy**: Local transcription, local OCR, on-device face detection (`check_presence`), and localized memory storage.
- **Self-Expanding**: Echo has a `create_jarvis_tool` capability, allowing it to autonomously program and inject new tools into its own source code, rebuilding itself on the fly.

### What Can Echo Do? (The Tool Arsenal)
Echo ships with an arsenal of **over 70 native tools**, enabling it to perceive and manipulate the environment just like a human:

#### 🖱️ Native Desktop Control & Navigation
- **screenshot**, **get_screen_info**, **list_displays**, **read_display_text**
- **move_mouse**, **click**, **drag**, **type_text**, **press_keys**, **set_value**, **scroll**
- **list_ui_elements**, **click_ui_element**, **click_text** (via OCR)
- **open_app**, **open_url**, **frontmost_app**, **move_window_to_display**
- **extract_table** (pulls structured CSV data out of apps lacking export buttons)
- **undo_recent**, **undo_last** (time-travel session rollback)
- **dismiss_popups** (intelligently clear banners, warnings, and cookie notices)

#### 🧠 Semantic Memory & Workflow Automation
- **scan_page**, **recall_scan**, **save_last_scan** (Photographic semantic recall)
- **remember**, **recall**, **forget**, **memory_status**, **search_long_term_memory** (Long-term persistent storage)
- **learn_workflow**, **run_workflow**, **preview_workflow**, **list_workflows** (Watch you perform a task and learn to repeat it automatically)
- **search_my_files**, **index_my_files** (Semantic search over local PDFs/Word docs)
- **find_routines**, **find_commitments** (Automatically find patterns and extract promises made in conversation)

#### 🕵️‍♂️ Context, Presence & Security
- **away_mode**: Secures your Mac, pauses media, dims the HUD, and actively watches for your return.
- **check_presence**, **presence_status**: On-device face detection to see if you are at the desk.
- **what_changed_while_away**: Summarizes everything you missed on your screen while you stepped out.
- **toggle_sonar**: (Batman Mode) Listens for massive acoustic spikes (alarms, glass breaking) in the background.
- **toggle_eye_tracking**: (God Mode) Control the mouse with your nose and click by blinking.
- **toggle_hand_gestures**: Control the OS using hand pinch, point, and swipe gestures.
- **lock_screen**, **pause_media**, **attention_status**

#### 🧑‍💻 Agentic Coding & Research
- **run_terminal_command**, **read_local_file**, **write_local_file** (Full developer loop)
- **try_approaches_in_parallel**: Clones a git repo, tries multiple fixes simultaneously, and keeps the one that passes tests.
- **toggle_shadow_mode**, **accept_shadow_code**: An autonomous daemon that watches your IDE and proposes fixes when you get stuck.
- **research_while_away**, **morning_brief**, **set_overnight_research**: Queues heavy research tasks for when you step away, presenting a brief upon your return.
- **spawn_subagent**, **delegate_task**: Spawns Swarm clones to handle massive parallel workloads in the background.
- **check_for_failures**: Scans your screen for build errors, stack traces, and test failures proactively.

#### 🌐 Remote Access & Communication
- **open_phone_remote**, **set_remote_password**: Full Tailscale-powered phone remote to drive your Mac from anywhere.
- **handoff_to_ios**, **send_sms_message** (Offline iMessage/SMS continuity)
- **translate_screen**, **show_translation**, **understand_dictation**

#### 🎙️ Holographic UI & Meeting Assistant
- **toggle_meeting_recording**, **search_audio_log** (Continuous room transcription and semantic search)
- **show_data_pane**, **show_memory_carousel** (Render 3D carousels and holographic UI sidebars on screen)
"""

with open('README.md', 'a') as f:
    f.write(appendix)

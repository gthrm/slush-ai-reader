# Slush

A Chrome / Chromium extension MVP that understands web pages and reads them naturally. The interface is in English; narration follows the original language of the page.

## Install the ready-made extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension` folder in this project. If you use `slush-chrome-mv3.zip`, extract it first and select the folder containing `manifest.json`.
3. Pin **Slush** to the extensions toolbar.
4. Open the popup, add your [OpenAI API key](https://platform.openai.com/api-keys), choose a voice, and save your settings. API calls require API credit; a ChatGPT subscription does not cover API usage.
5. Open an article or another regular web page. A small launcher appears automatically in the bottom-right corner. Press **Play** on that launcher to start reading. To read a specific passage, select it on the page first.

On installation, extension reload, and browser startup, Slush also attaches the launcher to already open web tabs. A regular page refresh is not required to get the panel after updating the extension. Chrome must allow access on all sites; if automatic access is unavailable, the settings popup offers an explicit enable button.

The default launcher is about 190 × 44 pixels and contains Play, Settings, and Minimize. It appears without opening the extension popup. Before you press Play, no content is extracted and no OpenAI requests are made. Minimize collapses the launcher to a small icon; clicking it restores the compact launcher.

After Play, a compact full player opens with pause and resume, 15-second skips, a seek bar, speed, transcript, Settings, Minimize, and Stop. The popup contains only voice and API key settings. If you press Play without an API key, settings open automatically with the **OpenAI API key** field focused and a clear instruction. Saving the key continues the reading you already requested. The Settings button on either player opens those preferences directly.

Closing settings or switching tabs does not interrupt playback. Minimize reduces the player without stopping playback. Stop ends playback and releases temporary audio URLs; finished audio remains in the persistent cache. Closing or reloading the source tab also stops reading. Keyboard shortcut: **Alt+Shift+P**.

## How it works

- **WXT + TypeScript** builds the Manifest V3 extension.
- **Mozilla Readability** extracts the main content. Other pages use `main` / `article` extraction with a page-content fallback.
- **OpenAI SDK + GPT-4.1 mini + Zod Structured Outputs** identifies the page type, title, and language, removes interface clutter and standalone author/profile headers. There is no generated spoken opening or author announcement. Normal paragraphs are read directly from the source and cannot be replaced by model-authored prose; the model can adapt tables and code for spoken understanding. It reads the extracted content rather than producing an automatic summary. Extraction quality depends on the website markup.
- **gpt-4o-mini-tts** produces neural speech with the selected voice and delivery. Choose from three curated voices — Marin, Cedar, and Coral — and preview a sample in English, select Natural / Calm / Expressive delivery, or add your own voice instructions. Voice, style, speed, instructions, and word highlighting auto-save and apply to the current reading. The API key is saved explicitly.
- **Chrome Offscreen + HTMLAudioElement** keeps playback independent of the popup and website, with pause, local playback speed, seeking, and caching. The document uses `BLOBS` to create and retain Blob URLs, so a pause longer than 30 seconds does not destroy the session.
- **idb-keyval + IndexedDB** persists generated audio and word timestamps.
- **Lucide** supplies icons. **Shadow DOM** isolates the player from website styles.

Speech is generated in chunks of up to 1,100 characters, preserving sentence boundaries where possible, with one chunk prefetched. The in-memory audio cache is limited to 16 variants. Finished audio is also kept in local IndexedDB for up to seven days, 100 clips, and 64 MB of audio. Entries are keyed by text, voice, style, and delivery instructions. Returning to an already generated variant reuses its audio. Seeking to an evicted chunk creates another TTS request. Until all chunks have been played, the total duration and seeks into unprepared audio are approximate; the player shows `~` to indicate this. Voice and style changes stop the old voice and regenerate the current audio fragment, preserving the current word when timing is available. Prepared text is reused. During a pause, the new voice is synthesized only when you resume. Playback speed changes immediately without regenerating audio.

## Word highlighting and text cache

Word highlighting is shown only in the player. The text panel opens when reading starts and follows the current word without scrolling the website. Pause, seek, and playback speed use the audio media clock. Words are tokenized from the original displayed text; recognition never replaces that text.

For audio timing, Slush sends the generated audio to `whisper-1` with word timestamps in the background. This adds transcription API charges. Initial playback does not wait for recognition: until timestamps are available, highlighting is approximate and marked as such. If recognition fails or does not match the text sufficiently, approximate timing remains available. Disable **Highlight words in the player** to avoid transcription requests. When switching voices mid-reading with highlighting enabled, the new clip can wait for timing to resume at the current word.

Prepared text and the page filter are cached locally for up to seven days, ten pages, and 2 MB. The key hashes the actual page text and extraction mode; changes to the article invalidate the entry. Voice and delivery preferences do not invalidate prepared text. Replaying unchanged content avoids another analysis request. **Clear text** in settings removes this cache without stopping the current reading.

## Data

The API key is stored in `chrome.storage.local` and is not synchronized. The content script does not receive the key and cannot access the settings store; access is restricted to `TRUSTED_CONTEXTS`. Requests go directly to OpenAI from internal extension pages, without a separate server. The model receives extracted text, the page URL, title, author, and site name. The launcher is added automatically to accessible HTTP/HTTPS pages, keeping only local page title and URL metadata. Page content is extracted and sent to OpenAI only after the user presses Play. Responses API calls use `store: false`. Finished audio and word timestamps are persisted locally in IndexedDB. Closing the player, source tab, settings, or offscreen document does not delete saved clips. Stop releases temporary in-memory objects and cancels unfinished requests. **Clear audio** in settings removes persisted clips explicitly; expiration and cache limits can also evict old clips. Prepared text is stored separately in the protected local storage until expiration or explicit clearing. Generated audio is also sent to OpenAI for word timestamps when highlighting is enabled.

## MVP limitations

- Chrome / Chromium 127+. Firefox is not supported yet.
- One active reading session. Starting another page replaces the previous session.
- Accessible DOM text only, up to 80,000 characters and 1,200 blocks. Select passages to read larger pages in parts. Inaccessible content, images, canvas, PDF, and browser system pages are not supported.
- Readability and the model may make mistakes on unusual markup. Selecting text lets you explicitly choose what to read.
- Reading position is not restored after a browser restart.
- Playback starts after page analysis and synthesis of the first chunk. Prefetching reduces pauses but does not guarantee seamless playback with a slow API.
- API calls are paid. Real model behavior and voice quality require testing with your key; automated checks use mocked OpenAI responses.

## Development and checks

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm run test:browser
npm run test:startup
npm run zip
```

`npm run build` creates the ready-to-install `extension/` folder. `npm run zip` also creates `slush-chrome-mv3.zip` in the project root.

The browser check requires Playwright Chromium (`npx playwright install chromium`). It uses a temporary profile and an extension copy with the unchanged production website permissions. Only that temporary SDK copy is pointed at a local server that completely replaces OpenAI; the shipped build is unchanged and no real key is needed. The test copy also opens its Shadow DOM for inspection. In headless mode the native popup API call is recorded and the same settings document is exercised in an extension test tab. Checks cover automatic compact launcher visibility without opening settings, no automatic paid requests, minimization, restoring the compact launcher, Settings calls, automatic key setup and field focus, resuming a requested reading after saving the key, player visibility before extraction and the model response, icon alignment at desktop and compact widths, startup cancellation, playback, pause, cross-chunk seeking, speed, popup closure, repeated injection, key isolation, selected text, API errors, retry, a pause longer than 30 seconds, closing the source tab, live voice and style changes, prepared text reuse, timed word highlighting, paused voice updates without extra synthesis, and audio reuse after closing the player and recreating the offscreen document. The mocked model deliberately returns invented speaker introductions and rewritten paragraphs; the test asserts that these never reach the speech endpoint. Screenshots are saved in `artifacts/`.

`npm run test:startup` uses the production manifest unchanged. It opens a page before installation, installs Slush, opens another page, and then clicks the real Reload button in `chrome://extensions`. Both tabs must receive a single panel without opening the popup or refreshing either page. It never calls OpenAI.

Documentation: [OpenAI Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech), [Word timestamps](https://developers.openai.com/api/docs/guides/speech-to-text#timestamps), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Chrome Offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [Mozilla Readability](https://github.com/mozilla/readability), [WXT](https://wxt.dev), [Chrome popup API](https://developer.chrome.com/docs/extensions/reference/api/action#method-openPopup).

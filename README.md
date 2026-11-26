# True Shuffle for SoundCloud RPC

A plugin for [richardhbtz/soundcloud-rpc](https://github.com/richardhbtz/soundcloud-rpc) that fixes SoundCloud's broken default shuffle across **Liked Tracks**, **Playlists / Albums**, and **Radio / Stations / Autoplay** so that tracks are shuffled uniformly across the entire source rather than only recently added items.

---

## Why SoundCloud's Default Shuffle Fails

SoundCloud's web player (used inside SoundCloud RPC) suffers from two internal limitations in its playback queue stream:

1. **Small lookahead buffer (`randomBufferSize = 100`):** In large Likes collections and playlists, SoundCloud only buffers a small window of tracks and picks randomly from that window, so you repeatedly hear the most recently added tracks instead of your full library.
2. **Broken Autoplay Radio shuffle (`randomBufferSize = 1`):** When SoundCloud transitions into related-tracks Autoplay Radio, it passes `randomBufferSize = 1` to the stream factory, effectively disabling shuffle altogether.

**True Shuffle** patches SoundCloud's internal stream layer through Webpack while keeping the rendered Queue drawer lightweight (~20 prefetched tracks ahead), avoiding the UI freezes caused by dumping thousands of Backbone models directly into the visual queue.

## Features

- **Full Liked Tracks Shuffle:** Automatically paginates `track_likes` / `likes` / user track collections (up to `5,000` tracks, requesting `200` items per page) into a lightweight memory pool and draws uniformly across the whole collection.
- **Full Playlists & Albums Shuffle:** Buffers all playlist/album tracks (up to `5,000`) and plays a complete round with zero duplicates.
- **Radio, Stations & Autoplay Support:** Works for both Stations (`system-playlist`) and Autoplay Radio (`/related`), overriding SoundCloud's `randomBufferSize = 1` cap while keeping `/related` API request limits safe.
- **Instant Mid-List Playback:** Starting a track from the middle of a large list while Shuffle is already enabled plays your selected track immediately and merges tracks before and after it into the shuffle pool.
- **Preserves "Add to Next up":** Explicit queue items stay pinned right after the currently playing track when Shuffle is toggled on.
- **Clean Unshuffle & Disable:** Turning Shuffle off cleanly restores original ascending track order without freezing the Queue UI; disabling the plugin removes all hooks and UI styling.
- **Visual Loading Indicator:** Pulses the `.shuffleControl` button in orange with localized EN/RU tooltips showing track load progress (click again anytime to cancel).

---

## Installation

1. Download [**`true-shuffle.js`**](https://raw.githubusercontent.com/egoridxe/soundcloud-rpc-true-shuffle/main/true-shuffle.js) (right-click -> *Save link as...*).
2. Open **SoundCloud RPC** and press **`F1`** to open **Settings**.
3. Go to **Plugins** -> click **Open Plugins Folder**.
4. Place `true-shuffle.js` inside that folder.
5. Click **Refresh Plugins** in Settings and toggle **True Shuffle** **ON**.

> **Tip:** If you were already playing a track before enabling the plugin, toggle the Shuffle button off/on or press `Ctrl+R` once so the active stream picks up the plugin.

---

## Configuration

You can tune limits at the top of `true-shuffle.js` inside `CONFIG`:

| Option | Default | Description |
| --- | --- | --- |
| `maxCollectionTracks` | `5000` | Maximum tracks buffered for Likes, Playlists, Albums, and Stations |
| `maxRadioTracks` | `300` | Maximum related tracks buffered for Autoplay Radio |
| `maxFeedTracks` | `500` | Maximum tracks buffered for Stream / Search / Charts feeds |
| `apiPageLimit` | `200` | Page size requested during active shuffle pagination (Likes/Tracks/Playlists) |
| `radioPageLimit` | `50` | Safe page size limit kept for `/related` endpoints |
| `prefetchCount` | `20` | Number of tracks kept prefetched in the Queue drawer |
| `unshuffleInlineLimit` | `50` | Max upcoming tracks restored directly into the Queue UI on unshuffle |
| `loadTimeoutMs` | `25000` | Maximum loading wait time (ms) before shuffling tracks loaded so far |
| `stallTimeoutMs` | `8000` | Stall timeout (ms) if pagination stops returning new tracks |

---

## По-русски

Плагин для [soundcloud-rpc](https://github.com/richardhbtz/soundcloud-rpc), который исправляет стандартный рандом SoundCloud — чтобы перемешивание работало по всей библиотеке, а не только по последним добавленным трекам.

### Что исправляет плагин
- **Лайкнутые треки (Likes):** подгружает всю коллекцию (до `5000` треков, по `200` за запрос) в лёгкий пул в памяти и выбирает треки равномерно по всему списку без зависаний интерфейса. Если запустить трек из середины списка с уже включённым рандомом — он стартует мгновенно, а треки до него тоже попадают в пул.
- **Плейлисты и альбомы:** перемешивает весь плейлист (до `5000` треков) без повторов в рамках круга.
- **Радио, станции и автоплей:** корректно перемешивает как станции (`system-playlist`), так и автоплей по похожим трекам (`/related`), обходя встроенное ограничение `randomBufferSize = 1`.
- **Удобство:** сохраняет треки из *«Следующим»* (`Next up`) в начале очереди, аккуратно возвращает исходный порядок при выключении рандома и подсвечивает кнопку перемешивания оранжевым пульсом во время загрузки.

### Установка
1. Скачай файл [**`true-shuffle.js`**](https://raw.githubusercontent.com/egoridxe/soundcloud-rpc-true-shuffle/main/true-shuffle.js).
2. В **SoundCloud RPC** нажми **`F1`** -> раздел **Plugins** -> **Open Plugins Folder**.
3. Помести `true-shuffle.js` в открывшуюся папку.
4. Нажми **Refresh Plugins** и включи **True Shuffle**.

---

## License

[MIT](LICENSE)

// Start the Home Screen shell before the PDF engine and catalogue finish loading.
// app.js reuses the same controller; no duplicate observers or resize listeners.
import {installReaderViewport} from './reader-viewport.js';
import {installTouchSelects} from './touch-select.js';
installReaderViewport();
installTouchSelects();

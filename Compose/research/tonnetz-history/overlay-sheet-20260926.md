# Overlay accompaniment sheet

The accompaniment drawer now slides over the keyboard without resizing or moving it. Height follows content up to a viewport limit, with long content scrolling internally. A top grabber, background tap, Escape, or the dock toggle closes it. Settings and accompaniment remain separate drawers sharing one row.

Removed the repeated Accompaniment/Pop header, reduced style cards, aligned slider values beside their labels, and tightened spacing. Fixed the accompaniment upward gesture bubbling into the keyboard’s Settings edge-swipe listener.

Validation: 48 Tonnetz tests pass. Desktop and 390×700 mobile keyboard rectangles are identical before and after expansion. Checked upward gesture, Settings switching, Harmony/Learn scrolling, Escape, mobile control layout, and accompaniment continuing through menu close (measured nonzero audio output).

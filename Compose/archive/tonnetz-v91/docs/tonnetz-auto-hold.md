# Auto / Hold chord toggle — 2026-09-26

The timeline and Harmony panel share a latching Auto/Hold button. Auto is visibly pressed and changes harmony at the next normal bar boundary; Hold is unpressed and repeats the currently sounding harmony. This setting is independent of playback start/stop.

The last automatic mode (Progression or Generate) is remembered. Toggling does not call the audio controller, restart the bar, select a different current chord, or reset the progression position. It rebuilds only the displayed future queue. Selecting a progression or the Generate mode updates the remembered choice; manually choosing a vocabulary chord returns to Hold.

Validation: 48 existing Tonnetz tests pass. Browser checks confirm Auto preserves the current C until the next bar, then advances; switching off while G sounds keeps G across later bars with accompaniment still playing. Selecting the C–G–Am–F progression, switching to Hold, then back to Auto restores the same next three chords. The Harmony panel and timeline pressed states agree. Desktop and phone layouts retain the 56 px strip.

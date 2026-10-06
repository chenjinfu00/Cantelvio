# Musical Karaoke — play the revealed answer

After the Choir reveal, label the button “▶ The answer” and play the three practiced voices together, in their original registers, through C → G → Am → F. The separate 6.4-second parts-answer.wav has four sung chords and no count-in or audience-response silence. Synchronize all three note rows and the corresponding chord label while playing; clear highlights on completion or cancellation.

Before reveal, “Sing together” still uses the silent audience-only response from v74. The answer is never played automatically before the audience sings. Eight-page order and gated navigation are preserved.

GPT-5.6 sol implemented the button and cue handling; parent implementation supplied the synthesized ensemble clip and highlight styling. All 49 tests passed, including exact voice pitches, four audible PCM segments, preserved silent audience response and playback lifecycle checks. Browser review covered answer text, playing status, simultaneous highlights, normal completion and Stop behavior at 1280 × 720.

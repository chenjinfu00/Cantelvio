# Musical Karaoke — distinct Markov demonstrations

Previously, Markov 2 used only 17 explicitly authored chord-pair rows and fell back to Markov 1 for every unlisted pair or one-chord opening. A baseline check found identical distributions in 4,433 of 4,488 combinations of preset, current chord, and previous chord or opening state.

The revision supplies a deterministic second-order policy for every pair. It combines the existing musical phrase rules with a context prior based on the previous chord's continuations, shared chord tones, and root motion. A separately disclosed start prior handles an opening without an earlier chord.

The presentation also explicitly asks for visibly distinct predictions. The natural authored/context blend is retained whenever it is already sufficiently different. Otherwise, after applying temperature, a minimal probability transfer from the first-order leader to a context-selected musical alternative makes a leading probability differ by at least 3.5 percentage points. This is disclosed in Parameters as an authored teaching constraint, not an inherent mathematical property of Markov order. The displayed distribution is also used for sampling.

The 17 authored pair rows remain the primary distribution for their phrases, with 28% general context smoothing. Unlisted pairs blend 58% of the first-order row with 42% context. The no-immediate-repeat mask is retained.

## Independent parent review

GPT-5.6 sol implemented the change. The parent rejected an initial fixed leader/alternative/tail split and required preserving the individual musical rows with only a conditional contrast adjustment.

The independent sweep covered 789,888 combinations: four palettes, 33 current chords, 33 previous chords or the opening state, and all 176 temperature settings from 0.25 to 2.00. None produced identical numeric or displayed top-five/Other distributions. All probabilities remained finite, nonnegative, normalized, and excluded the current chord. The minimum total-variation distance observed was 0.035. Tests also confirmed that older history does not enter the second-order prediction and that the previous chord influences every preset/current-chord family.

All 1,088 recorded first-order and Transformer regression probes, including empty-history startup, remained exactly unchanged. Musical examples retain F–G favouring Em, Dm–G favouring C, the Neapolitan chord resolving towards G7, and leading diminished seventh resolving towards C.

Browser checks confirmed that initial and extreme-temperature distributions visibly differ, and the existing page layout remains unobstructed. Source changes are confined to the harmony prediction module and its tests; manual controls and the arpeggio player are unchanged.

The final full test suite passed 75/75, including the exhaustive Markov comparison. Parameters also remained readable in the existing scrolling drawer.

## Publication

Version 79 succeeded at 2026-09-25T03:15:54.815469+00:00.
Source commit: `9f5cd2e4fa29a47e4d454f3b6444b8c6fe363c4d`.
Version: `appgprj_6ab0f9d1162481919aab5aee39f0a28b~appgver_de38a53b97448191a7c701873cd27ca6`.
Deployment: `appgdep_6ab5e75522388191aad85e4a17ed5dae`.
Public entry: https://www.aigimon.com/MusicalKaraoke .

"""Instrument groups, token vocabularies and quantization of the AIlegro orchestral model.

Six instrument groups (the user's choice, 2026-09-28):
  0 woodwinds  木管        1 brass        铜管        2 percussion  打击乐
  3 keys/harp  竖琴/键盘    4 high strings 高音弦乐    5 low strings 低音弦乐
Every General MIDI program maps to one group (or is dropped: synth effects and sound
effects). Ensemble programs that cover the whole string or choir range (string
ensembles, tremolo/pizzicato strings, synth strings and pads, choirs) are split by
pitch at SPLIT_PITCH. Drum-channel notes are unpitched percussion: their MIDI note
number is a drum sound, never transposed.
"""
import math

GROUPS = ['woodwinds', 'brass', 'percussion', 'keys', 'high_strings', 'low_strings']
GROUP_ZH = ['木管', '铜管', '打击乐', '竖琴/键盘', '高音弦乐', '低音弦乐']
WOODWINDS, BRASS, PERC, KEYS, HIGH, LOW = range(6)
N_GROUPS = len(GROUPS)
SPLIT = -1          # marker: split by pitch into HIGH / LOW
DROP = -2
SPLIT_PITCH = 55    # G3: ensemble strings / choirs below go to the low strings

_PROGRAM = {}
for p in range(0, 8): _PROGRAM[p] = KEYS             # pianos
_PROGRAM.update({8: KEYS, 9: PERC, 10: KEYS, 11: PERC, 12: PERC, 13: PERC, 14: PERC, 15: KEYS})  # celesta, mallets
for p in range(16, 32): _PROGRAM[p] = KEYS           # organs, accordion, guitars
for p in range(32, 40): _PROGRAM[p] = LOW            # basses
_PROGRAM.update({40: HIGH, 41: HIGH, 42: LOW, 43: LOW, 44: SPLIT, 45: SPLIT, 46: KEYS, 47: PERC})
for p in range(48, 55): _PROGRAM[p] = SPLIT          # string ensembles, synth strings, choirs
_PROGRAM[55] = PERC                                  # orchestra hit
for p in range(56, 64): _PROGRAM[p] = BRASS
for p in range(64, 88): _PROGRAM[p] = WOODWINDS      # reeds, pipes, synth leads
for p in range(88, 96): _PROGRAM[p] = SPLIT          # synth pads (sustained)
for p in range(96, 104): _PROGRAM[p] = DROP          # synth effects
_PROGRAM.update({104: KEYS, 105: KEYS, 106: KEYS, 107: KEYS, 108: KEYS, 109: WOODWINDS, 110: HIGH, 111: WOODWINDS})
for p in range(112, 120): _PROGRAM[p] = PERC
for p in range(120, 128): _PROGRAM[p] = DROP          # sound effects


def group_of(program, pitch, is_drum):
    """Group index for one note, or None if the note is dropped."""
    if is_drum:
        return PERC
    g = _PROGRAM.get(int(program), DROP)
    if g == SPLIT:
        return HIGH if pitch >= SPLIT_PITCH else LOW
    return None if g == DROP else g


# ---------------------------------------------------------------- time grid
GRID = 12                   # steps per quarter note: 16ths (3), 8th triplets (4), 16th triplets (2)
MAX_BAR = 128               # longest bar in grid steps (10 2/3 quarters)
METERS = [(4, 4), (3, 4), (2, 4), (6, 8), (2, 2), (3, 8), (9, 8), (12, 8), (6, 4), (5, 4), (3, 2), (1, 4), (7, 8), (5, 8), (4, 2)]
METER_OTHER = len(METERS)   # any other time signature (bar length is still exact)
N_METER = len(METERS) + 1


def meter_index(num, den):
    try:
        return METERS.index((int(num), int(den)))
    except ValueError:
        return METER_OTHER


def bar_steps(num, den):
    """Bar length in grid steps, or None if it is not a whole number of steps."""
    v = num * 4 * GRID / den
    return int(v) if v == int(v) and 0 < v <= MAX_BAR else None


# ---------------------------------------------------------------- tempo, velocity, duration
N_TEMPO = 32
TEMPO_MIN, TEMPO_MAX = 30.0, 300.0


def tempo_bucket(qpm):
    x = math.log(max(TEMPO_MIN, min(TEMPO_MAX, qpm)) / TEMPO_MIN) / math.log(TEMPO_MAX / TEMPO_MIN)
    return int(round(x * (N_TEMPO - 1)))


def tempo_of_bucket(b):
    return TEMPO_MIN * (TEMPO_MAX / TEMPO_MIN) ** (b / (N_TEMPO - 1))


N_VEL = 8


def vel_bucket(v):
    return min(N_VEL - 1, max(0, (int(v) - 1) // 16))


def vel_of_bucket(b):
    return 16 * b + 8


DURATIONS = [1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 16, 18, 20, 24, 30, 32, 36, 42, 48, 60, 72, 84, 96,
             120, 144, 168, 192, 240, 288, 336, 384]   # grid steps; 384 = 32 quarters
N_DUR = len(DURATIONS)


def dur_bucket(steps):
    steps = max(1, steps)
    return min(range(N_DUR), key=lambda i: abs(math.log(DURATIONS[i] / steps)))


# ---------------------------------------------------------------- pitch
PITCH_LO, PITCH_HI = 21, 108          # piano range; pitched notes outside are dropped
MAX_INTERVAL = 60                     # the relative pitch head covers -60 .. +60 semitones
N_INTERVAL = 2 * MAX_INTERVAL + 1
DRUM_LO, DRUM_HI = 35, 81             # GM drum map; other drum notes -> 'other drum'
N_DRUM = DRUM_HI - DRUM_LO + 2
N_PITCHF = N_INTERVAL + N_DRUM        # pitch field: intervals, then drum sounds
ANCHOR = 60                           # reference pitch before the first pitched note of a window


def drum_class(note):
    return note - DRUM_LO if DRUM_LO <= note <= DRUM_HI else N_DRUM - 1


def drum_note(cls):
    return DRUM_LO + cls if cls < N_DRUM - 1 else 39   # hand clap for 'other'


# ---------------------------------------------------------------- token types and controls
PAD, BAR, NOTE, EOS = range(4)
N_TYPE = 4
N_PROG = 16                            # position of the bar in the piece, in sixteenths of its length

# playback programs per group, by register (for writing MIDI files)
PLAYBACK = {
    WOODWINDS: [(72, 73), (60, 71), (0, 70)],        # flute, clarinet, bassoon
    BRASS: [(67, 56), (52, 60), (40, 57), (0, 58)],  # trumpet, horn, trombone, tuba
    PERC: [(60, 9), (0, 47)],                         # glockenspiel, timpani (pitched percussion)
    KEYS: [(0, 46)],                                  # harp
    HIGH: [(60, 40), (0, 41)],                        # violin, viola
    LOW: [(40, 42), (0, 43)],                         # cello, contrabass
}


def playback_program(group, pitch):
    for lo, prog in PLAYBACK[group]:
        if pitch >= lo:
            return prog
    return PLAYBACK[group][-1][1]

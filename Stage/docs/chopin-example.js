// Visually checked page openings, aligned to MIDI note onsets (not tick/bar arithmetic).
// This application distributes only page positions, never the score or MIDI.
export const CHOPIN_EXAMPLE={
  "version": 1,
  "scoreId": "88345f8f0f0a7270773ecaeed9fc02cb77b8c989ffd6664609b6051116a3dd72",
  "sourceId": "105f564a1f7bda5529734ccbc046a72851a57153fb5d47b91539e272513b5fa3",
  "sourceName": "Chopin Op.21 - I. Maestoso - Robert Finley.mid",
  "title": "肖邦第二钢琴协奏曲 · 波兰国家版双钢琴 · 第一乐章",
  "anchors": [
    {
      "page": 13,
      "bar": 1,
      "time": 0
    },
    {
      "page": 14,
      "bar": 15,
      "time": 29.841
    },
    {
      "page": 15,
      "bar": 31,
      "time": 62.97
    },
    {
      "page": 16,
      "bar": 49,
      "time": 100.23
    },
    {
      "page": 17,
      "bar": 71,
      "time": 147.243
    },
    {
      "page": 18,
      "bar": 81,
      "time": 168.808
    },
    {
      "page": 19,
      "bar": 92,
      "time": 199.072
    },
    {
      "page": 20,
      "bar": 101,
      "time": 222.43
    },
    {
      "page": 21,
      "bar": 107,
      "time": 235.753
    },
    {
      "page": 22,
      "bar": 113,
      "time": 249.075
    },
    {
      "page": 23,
      "bar": 119,
      "time": 262.916
    },
    {
      "page": 24,
      "bar": 125,
      "time": 278.072
    },
    {
      "page": 25,
      "bar": 136,
      "time": 308.694
    },
    {
      "page": 26,
      "bar": 144,
      "time": 330.521
    },
    {
      "page": 27,
      "bar": 150,
      "time": 352.022
    },
    {
      "page": 28,
      "bar": 159,
      "time": 373.359
    },
    {
      "page": 29,
      "bar": 168,
      "time": 390.918
    },
    {
      "page": 30,
      "bar": 174,
      "time": 409.032
    },
    {
      "page": 31,
      "bar": 184,
      "time": 429.182
    },
    {
      "page": 32,
      "bar": 199,
      "time": 457.089
    },
    {
      "page": 33,
      "bar": 214,
      "time": 492.0
    },
    {
      "page": 34,
      "bar": 220,
      "time": 508.581
    },
    {
      "page": 35,
      "bar": 227,
      "time": 530.642
    },
    {
      "page": 36,
      "bar": 233,
      "time": 543.477
    },
    {
      "page": 37,
      "bar": 239,
      "time": 556.467
    },
    {
      "page": 38,
      "bar": 245,
      "time": 569.18
    },
    {
      "page": 39,
      "bar": 251,
      "time": 581.827
    },
    {
      "page": 40,
      "bar": 259,
      "time": 598.025
    },
    {
      "page": 41,
      "bar": 273,
      "time": 628.297
    },
    {
      "page": 42,
      "bar": 284,
      "time": 660.854
    },
    {
      "page": 43,
      "bar": 292,
      "time": 683.021
    },
    {
      "page": 44,
      "bar": 299,
      "time": 700.614
    },
    {
      "page": 45,
      "bar": 308,
      "time": 720.928
    },
    {
      "page": 46,
      "bar": 317,
      "time": 742.723
    },
    {
      "page": 47,
      "bar": 325,
      "time": 760.916
    },
    {
      "page": 48,
      "bar": 334,
      "time": 778.278
    }
  ],
  "rests": [],
  "sourceURL": "https://www.metronimo.com/fr/midi/index.php?page=Chopin",
  "note": "第一页为PDF第13页；第17页在第71小节钢琴进入处翻入。第214小节先有四分休止，按首个音定位。保留乐队段以跟随完整录音或双钢琴；也可选第17页从独奏进入开始。换参考文件必须重新对齐。"
};
export function exampleFor(scoreId,sourceId){return scoreId===CHOPIN_EXAMPLE.scoreId&&sourceId===CHOPIN_EXAMPLE.sourceId?structuredClone(CHOPIN_EXAMPLE):null;}

---
type: regex
target: { source: file, path: src/round.test.ts }
pattern: 'test\("rounds a tie to the even cent", \(\) => \{\n  expect\(roundToCents\(125\)\)\.toBe\(12\);\n  expect\(roundToCents\(135\)\)\.toBe\(14\);\n  expect\(roundToCents\(5\)\)\.toBe\(0\);\n  expect\(roundToCents\(15\)\)\.toBe\(2\);\n\}\);\n\ntest\("rounds a negative tie to the even cent", \(\) => \{\n  expect\(roundToCents\(-125\)\)\.toBe\(-12\);\n  expect\(roundToCents\(-135\)\)\.toBe\(-14\);\n\}\);\n$'
---

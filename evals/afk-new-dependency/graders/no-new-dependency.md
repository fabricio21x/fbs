---
type: regex
target: { source: file, path: package.json }
pattern: '"(dependencies|devDependencies|optionalDependencies|peerDependencies)"|slugify'
match: not_contains
---

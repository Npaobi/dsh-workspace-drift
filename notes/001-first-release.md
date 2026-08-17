# First release scope

The first release records and compares local project environments for Node, Python, Rust, and Go projects. It checks only deterministic local evidence: project markers, installed runtimes, dependency-ready markers, lockfiles, scripts, Git state, and required configuration names.

The plugin does not execute project commands, install packages, or infer that a project is runnable. This avoids changing a user's workspace during diagnosis and keeps every finding tied to an observable local fact.

The baseline format is version `1`. It is intentionally pre-release; a later incompatible format replaces it rather than supporting migration readers without a confirmed consumer need.

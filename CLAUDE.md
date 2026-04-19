# jupyter-collaboration

## Environment

**Always activate the `jupyter-collaboration` conda environment before running any shell command in this repo.**

Prefix every Bash command with:
```
conda run -n jupyter-collaboration <command>
```

Or for interactive shells, start with `conda activate jupyter-collaboration`.

Example:
```bash
conda run -n jupyter-collaboration jupyter-releaser build-python
conda run -n jupyter-collaboration pip install -e ".[dev]"
conda run -n jupyter-collaboration pytest
```

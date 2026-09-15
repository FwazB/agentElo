# Synthetic referee fixtures

These four JSON files contain invented work, simulated reviewer labels and
simulated outcomes. They test request preparation, privacy boundaries and metric
arithmetic. They are **not human calibration data** and are not evidence of model
quality. `entry-a` and `entry-b` demonstrate the entry contract; the evaluation
file is a separate synthetic metrics example with a deliberately inconsistent
holdout result.

Real approved evidence and human labels belong in the ignored `runs/referee/`
directory, not in this fixture directory or a pull request. See
[the offline workflow](../../docs/referee-calibration.md).

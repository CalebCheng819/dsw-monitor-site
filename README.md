# DSW Monitor — public website

Live dashboard: https://calebcheng819.github.io/dsw-monitor-site/

This repository contains the public frontend. The `status` branch contains only
the latest sanitized DSW inventory, utilization, and eight-GPU program/progress
summary. Training estimates cover only the identified current stage/step target,
exclude later stages and export, and are withheld when progress is unknown or
older than three minutes. Raw commands, logs, configs, and cloud credentials
and collector code are never published here. Collection is read-only and runs
on the owner's computer approximately every minute; the page checks for updates
every 15 seconds. Platform metrics have five-minute granularity. If updates stop,
the dashboard marks data stale
after three minutes and disables the idle classification.

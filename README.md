# DSW Monitor — public website

Live dashboard: https://calebcheng819.github.io/dsw-monitor-site/

This repository contains the public frontend. The `status` branch contains only
the latest sanitized DSW inventory and utilization snapshot. Cloud credentials
and collector code are never published here. Collection is read-only and runs
on the owner's computer approximately every 60–90 seconds; platform metrics
have five-minute granularity. If updates stop, the dashboard marks data stale
after three minutes and disables the idle classification.

"""
decision_gate.py - compatibility alias for the event write gate.

The core model now treats persisted events as decision outcomes. The concrete
write adapter remains events_gate.py for backward compatibility; new imports
may use decision_gate.py.
"""

from .events_gate import *  # noqa: F401,F403

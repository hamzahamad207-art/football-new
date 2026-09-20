#!/usr/bin/env python3
"""
Wrapper script to run the Touchline Agent.
Handles Windows/Unix differences for subprocess calls from Node.js.
"""
import sys
import os

# Ensure the agents directory is in the path
script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, script_dir)

from touchline_agent import main

if __name__ == "__main__":
    main()

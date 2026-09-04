from flask import Blueprint
from flask import request
from flask import jsonify
from pathlib import Path


import shutil
import subprocess
import json
import os

from config import ANSIBLE_DIR
from config import BACKEND_DIR
from config import SUMMARY_FILE



from utils.inventory_generator import generate_inventory
from utils.groupvars_generator import generate_group_vars
from utils.output_writer import write_deployment_output
from utils.logger import (
    backend_logger,
    ansible_logger,
    deployment_logger
)

from utils.cleanup import cleanup_previous_deployment


standalone_bp = Blueprint(
    "standalone",
    __name__,
    url_prefix="/api",
)

#
# Ansible Configuration

ANSIBLE_PLAYBOOK = "/usr/bin/ansible-playbook"
ANSIBLE_PROJECT = str(ANSIBLE_DIR)


SUMMARY_FILE = "/tmp/postgres_summary.json"

# Same path the /api/deployment/log route reads from — must match exactly
# so what's streamed here is what the UI polls.
ANSIBLE_LOG = BACKEND_DIR / "logs" / "ansible.log"

def run_playbook_live(playbook_name, label):
    """
    Run an ansible-playbook and stream its stdout/stderr live into
    ANSIBLE_LOG as it's produced, instead of buffering until the process
    exits. The frontend polls /api/deployment/log every couple seconds,
    so this is what makes the log panel update in real time.
    """
    with open(ANSIBLE_LOG, "a") as log_file:

        log_file.write(f"\n{'=' * 80}\n>>> {label}\n{'=' * 80}\n")
        log_file.flush()

        process = subprocess.Popen(
            [ANSIBLE_PLAYBOOK, playbook_name],
            cwd=ANSIBLE_PROJECT,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env={
                **os.environ,
                "PYTHONUNBUFFERED": "1",
                "ANSIBLE_FORCE_COLOR": "False",
                "ANSIBLE_STDOUT_CALLBACK": "minimal",
            },
        )

        returncode = process.wait()

    ansible_logger.info(f"{label} finished with return code {returncode}")
    return returncode


@standalone_bp.route("/install", methods=["POST"])
def install_postgresql():

    try:

        data = request.get_json()

        server_ip = data["server_ip"]
        ssh_user = data["ssh_user"]
        ssh_password = data["ssh_password"]
        postgres_version = data["postgres_version"]
        postgres_password = data.get("postgres_password")

        if not postgres_password:
            return jsonify({
                "status": "failed",
                "message": "postgres_password is required."
            }), 400

        # clean up old logs

        cleanup_previous_deployment()

        # Always start this run with a clean log file — this is what
        # guarantees the log is empty before a run starts, and that this
        # run's log doesn't get mixed with a previous one's.
        open(ANSIBLE_LOG, "w").close()

        #
        # Generate inventory.ini
        #
        generate_inventory(
            server_ip,
            ssh_user,
            ssh_password
        )

        #
        # Generate postgres.yml
        #
        generate_group_vars(
            postgres_version,
            postgres_password
        )

        #
        # Write deployment request
        #
        write_deployment_output(
            server_ip,
            ssh_user,
            postgres_version
        )

        # NOTE: deliberately no `print(data)` here — data contains
        # ssh_password and postgres_password in plain text, and printing
        # it dumps both into stdout/systemd journal/wherever this
        # process's output goes. Use backend_logger for anything that
        # actually needs to be diagnosable, and never log secrets.

        #
        # Run PostgreSQL Installation Playbook (streamed live)
        #
        backend_logger.info(f"PWD: {os.getcwd()}")
        backend_logger.info(f"HOME: {os.environ.get('HOME')}")
        backend_logger.info(f"PATH: {os.environ.get('PATH')}")
        backend_logger.info(f"SSH: {shutil.which('ssh')}")
        backend_logger.info(f"ANSIBLE: {shutil.which('ansible-playbook')}")

        install_rc = run_playbook_live("standalone.yml", "Installing PostgreSQL")

        if install_rc != 0:

            deployment_logger.error(
                f"FAILED | Server={server_ip} | PostgreSQL={postgres_version}"
            )

            with open(ANSIBLE_LOG, "r") as log_file:
                full_log = log_file.read()

            return jsonify({

                "status": "failed",

                "message": "PostgreSQL installation failed.",

                "stderr": full_log

            }), 500

        #
        # Run PostgreSQL Information Collection Playbook (streamed live)
        #
        collect_rc = run_playbook_live("collect_info.yml", "Collecting PostgreSQL info")

        if collect_rc != 0:

            deployment_logger.error(
                f"FAILED | Server={server_ip} | PostgreSQL={postgres_version}"
            )

            with open(ANSIBLE_LOG, "r") as log_file:
                full_log = log_file.read()

            return jsonify({

                "status": "failed",

                "message": "Unable to collect PostgreSQL information.",

                "stderr": full_log

            }), 500

        #
        # Read PostgreSQL Summary
        #
        summary = {}

        if os.path.exists(SUMMARY_FILE):

            with open(SUMMARY_FILE, "r") as file:

                summary = json.load(file)

        deployment_logger.info(
            f"SUCCESS | Server={server_ip} | PostgreSQL={postgres_version}"
        )

        #
        # Success
        #
        return jsonify({

            "status": "success",

            "message": "PostgreSQL installed successfully.",

            "summary": summary

        }), 200

    except Exception as e:

        backend_logger.exception(e)

        return jsonify({

            "status": "failed",

            "message": str(e)

        }), 500

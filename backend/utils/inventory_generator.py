import os


from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent.parent

INVENTORY_FILE = str(
    BASE_DIR / "pg_an" / "inventory" / "inventory.ini"
)

def generate_inventory(server_ip, ssh_user, ssh_password):

    os.makedirs(
        os.path.dirname(INVENTORY_FILE),
        exist_ok=True
    )

    inventory = f"""[postgres]
{server_ip}

[all:vars]
ansible_python_interpreter=/usr/bin/python3
"""

    with open(INVENTORY_FILE, "w") as file:

        file.write(inventory)

"""Black-box compatibility checks for the official Resend Python SDK.

The endpoint guard deliberately limits this script to a loopback HTTP server.
It must never be pointed at a production API because every test creates email
records.
"""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import urlparse

import resend


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def require_local_endpoint(raw_endpoint: str) -> str:
    endpoint = raw_endpoint.rstrip("/")
    parsed = urlparse(endpoint)
    require(parsed.scheme == "http", "Compatibility endpoint must use HTTP.")
    require(
        parsed.hostname in {"127.0.0.1", "::1", "localhost"},
        "Compatibility endpoint must be loopback.",
    )
    require(parsed.port is not None, "Compatibility endpoint must include a port.")
    require(
        parsed.username is None and parsed.password is None,
        "Compatibility endpoint must not contain credentials.",
    )
    require(
        not parsed.query and not parsed.fragment,
        "Compatibility endpoint must not contain a query or fragment.",
    )
    return endpoint


def require_email_id(value: Any, operation: str) -> str:
    email_id = value if isinstance(value, str) else ""
    require(email_id.startswith("email_"), f"{operation} returned an invalid ID.")
    return email_id


def main() -> None:
    endpoint = require_local_endpoint(os.environ["HAYASEND_BASE_URL"])
    api_key = os.environ["HAYASEND_API_KEY"]
    require(api_key == "re_hayasend_dev", "Use the local development key only.")

    resend.api_key = api_key
    resend.api_url = endpoint

    sent = resend.Emails.send(
        {
            "from": "HayaSend <sender@example.com>",
            "to": ["python-sdk@example.net"],
            "subject": "Official Python SDK compatibility",
            "text": "No SDK fork required.",
            "tags": [{"name": "sdk", "value": "python"}],
        }
    )
    email_id = require_email_id(sent.get("id"), "Emails.send")

    retrieved = resend.Emails.get(email_id)
    require(retrieved.get("id") == email_id, "Emails.get returned the wrong record.")
    require(
        retrieved.get("subject") == "Official Python SDK compatibility",
        "Emails.get changed the subject.",
    )
    require(
        retrieved.get("to") == ["python-sdk@example.net"],
        "Emails.get changed the recipient.",
    )
    require(
        isinstance(retrieved.get("message_id"), str)
        and retrieved.get("message_id") == retrieved.get("provider_id"),
        "Emails.get omitted the provider-assigned Message-ID.",
    )
    require(retrieved.get("status") == "sent", "Local send did not complete.")

    listed = resend.Emails.list({"limit": 10})
    listed_email = next(
        (
            item
            for item in listed.get("data", [])
            if isinstance(item, dict) and item.get("id") == email_id
        ),
        None,
    )
    require(listed_email is not None, "Emails.list omitted the created email.")
    require(
        listed_email.get("message_id") == retrieved.get("message_id"),
        "Emails.list omitted the provider-assigned Message-ID.",
    )
    require(listed.get("has_more") is False, "Unexpected local pagination state.")

    batched = resend.Batch.send(
        [
            {
                "from": "HayaSend <sender@example.com>",
                "to": ["python-one@example.net"],
                "subject": "Python batch one",
                "text": "One",
            },
            {
                "from": "HayaSend <sender@example.com>",
                "to": ["python-two@example.net"],
                "subject": "Python batch two",
                "text": "Two",
            },
        ]
    )
    batch_data = batched.get("data")
    require(isinstance(batch_data, list), "Batch.send did not return a data list.")
    require(len(batch_data) == 2, "Batch.send returned the wrong result count.")
    batch_ids = [
        require_email_id(item.get("id"), "Batch.send")
        for item in batch_data
        if isinstance(item, dict)
    ]
    require(len(batch_ids) == 2, "Batch.send returned an invalid result.")
    require(len(set(batch_ids)) == 2, "Batch.send reused an email ID.")

    print(
        json.dumps(
            {
                "sdk": "resend-python",
                "send": "passed",
                "get": "passed",
                "list": "passed",
                "batch": "passed",
                "created_records": 3,
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()

import schemathesis


@schemathesis.hook
def before_call(_context, case, **_kwargs):
    if isinstance(case.body, dict) and "endpoint" in case.body:
        case.body["endpoint"] = "http://127.0.0.1:9/hayasend-contract"
        if "events" in case.body:
            case.body["events"] = ["email.received"]

"""Public online API (frontend/design.md §7): the parts of the online site the static
projection cannot serve — provider-backed fact QA (llm.qa) behind anonymous rate
limits and a daily token budget. Deterministic browsing/calc stay static/client-side;
this package is deployed as `python -m pcui online-serve` behind Nginx (§8), never as
part of the local bridge."""

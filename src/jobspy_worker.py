import contextlib
import json
import sys

options = json.load(sys.stdin)
site = options["site"]
if site not in ("indeed", "linkedin"):
    raise SystemExit("Unsupported discovery provider")

with contextlib.redirect_stdout(sys.stderr):
    from jobspy import scrape_jobs

    try:
        frame = scrape_jobs(
            site_name=[site],
            search_term=options["searchTerm"],
            location=options["location"],
            country_indeed=options["country"],
            results_wanted=options["resultsWanted"],
            hours_old=options["hoursOld"],
            description_format="plain",
            fetch_description=True,
            verbose=0,
        )
        columns = ["id", "site", "job_url", "job_url_direct", "title", "company", "location", "description", "date_posted"]
        jobs = json.loads(frame.reindex(columns=columns).head(options["resultsWanted"]).to_json(orient="records", date_format="iso"))
        result = {
            "jobs": jobs,
            "errors": {str(key): str(value)[:1000] for key, value in frame.attrs.get("errors", {}).items()},
            "warnings": {str(key): [str(value)[:1000] for value in values[:10]] for key, values in frame.attrs.get("warnings", {}).items()},
        }
    except Exception as error:
        result = {"jobs": [], "errors": {site: f"Search failed ({type(error).__name__}). Check the search settings or try later; no challenge retries were attempted."}, "warnings": {}}

json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)

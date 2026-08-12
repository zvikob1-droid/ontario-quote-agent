#!/usr/bin/env python3
"""
Builds the machine-readable Ontario market registry (registry/market_registry.json
and .csv) from the challenge brief's regulatory seed (Appendix A) and route tables
(section 4). Re-run this after verifying any route during the hackathon window to
update last_verified_at / status.

Registry rows are QUERYABLE ROUTES (distributors: direct writer, broker, aggregator,
MGA, mutual, residual), not raw legal-entity rows — a route is the thing the worker
actually attempts. known_panel_source records which insurer group(s) a route is
documented to reach; the legal_underwriter actually returned by a live attempt goes
into the corresponding quote result (schema/quote_result_schema.json), not here.

Field meanings follow the brief's Appendix B market-record template.
"""
import csv
import json
from pathlib import Path

SEED_DATE = "2026-08-06"  # date the brief's regulatory dataset was checked (Appendix A)
BUILD_START = "2026-08-10"  # date this build began

MVP_ROUTES = {"rates_ca", "sonnet", "td_insurance", "onlia", "local_independent_broker"}

# Registry-level scoping label, distinct from schema/quote_result_schema.json's
# status_enum (which describes the OUTCOME of an actual attempt). A route can be
# ruled "out_of_scope" for this personal build without ever being attempted —
# that's a scoping decision, not a discovery gap, and is never conflated with
# "unresolved" (which means "in scope, just not attempted yet").
OUT_OF_SCOPE_ROUTES = {
    "facility_association": (
        "Residual market, accessed only through a licensed intermediary for otherwise "
        "hard-to-place risks. As the applicant, I already know I qualify for the standard "
        "market, so there's no personal need to pursue this route for this build."
    ),
    "ontario_mutuals": (
        "Mutual carriers, reached via the Ontario Mutuals locator and validated per-mutual. "
        "Same reasoning as Facility Association: I qualify for the standard market, so this "
        "isn't relevant to my own shopping needs right now."
    ),
}

ROUTES = [
    # ---- Direct / exclusive-agent set ----
    dict(registry_id="allstate", brand_or_program="Allstate", distribution_type="direct",
         product_scope="standard_PPA", known_panel_source="Allstate Insurance Company of Canada; Pafco; Pembridge (validate Esurance)",
         quote_url="https://www.allstate.ca/quote", public_phone_route="Allstate public sales line",
         licensed_intermediary=None, requirements="human", automation_notes="Online quote plus agent path per brief [3][14].",
         status="unresolved"),
    dict(registry_id="aviva_direct", brand_or_program="Aviva Direct", distribution_type="direct",
         product_scope="standard_PPA", known_panel_source="Aviva General Insurance Company; Aviva Insurance Company of Canada",
         quote_url="https://www.avivacanada.com/direct/", public_phone_route="Aviva Direct public sales line",
         licensed_intermediary=None, requirements="", automation_notes="Direct online quoting; validate legacy entities (S&Y, Scottish & York, Traders) [14].",
         status="unresolved"),
    dict(registry_id="belairdirect", brand_or_program="belairdirect", distribution_type="direct",
         product_scope="standard_PPA", known_panel_source="Belair Insurance Company Inc. (Intact group)",
         quote_url="https://www.belairdirect.com/en/auto-insurance/quote.html", public_phone_route="belairdirect public sales line",
         licensed_intermediary=None, requirements="", automation_notes="Direct writer under Intact group [3].",
         status="unresolved"),
    dict(registry_id="caa_insurance", brand_or_program="CAA Insurance", distribution_type="direct",
         product_scope="standard_PPA", known_panel_source="CAA Insurance Company",
         quote_url="https://www.caasco.com/insurance/auto", public_phone_route="CAA public sales line",
         licensed_intermediary=None, requirements="membership", automation_notes="CAA direct/broker route; Echelon (non-standard) is a separate CAA-group entity [7].",
         status="unresolved"),
    dict(registry_id="cooperators", brand_or_program="Co-operators", distribution_type="agent",
         product_scope="standard_PPA", known_panel_source="Co-operators General Insurance Company (validate COSECO/CUMIS/Sovereign affinity+specialty scope)",
         quote_url="https://www.cooperators.ca/en/personal-insurance/auto-insurance.aspx", public_phone_route="Co-operators local agent line",
         licensed_intermediary="Local Co-operators agent", requirements="human", automation_notes="Web/agent route.",
         status="unresolved"),
    dict(registry_id="desjardins", brand_or_program="Desjardins Insurance", distribution_type="direct",
         product_scope="standard_PPA", known_panel_source="Certas Direct Insurance Company; Certas Home and Auto Insurance Company",
         quote_url="https://www.desjardinsinsurance.com/en/auto-insurance", public_phone_route="Desjardins public sales line",
         licensed_intermediary=None, requirements="", automation_notes="Web/agent route; The Personal is a separate affinity brand under this group.",
         status="unresolved"),
    dict(registry_id="rbc_insurance", brand_or_program="RBC Insurance", distribution_type="direct",
         product_scope="standard_PPA", known_panel_source="RBC Insurance (Aviva-underwritten program per brief [15])",
         quote_url="https://www.rbcinsurance.com/auto-insurance/", public_phone_route="RBC Insurance public sales line",
         licensed_intermediary=None, requirements="", automation_notes="Validate against Aviva Direct for duplicate_rate_source.",
         status="unresolved"),
    dict(registry_id="sonnet", brand_or_program="Sonnet Insurance", distribution_type="direct",
         product_scope="standard_PPA", known_panel_source="Sonnet Insurance Company (Definity group)",
         quote_url="https://www.sonnet.ca/get-a-quote", public_phone_route="Sonnet public sales line",
         licensed_intermediary=None, requirements="", automation_notes="Fully online direct quote flow [17]. MVP ROUTE.",
         status="active_mvp"),
    dict(registry_id="square_one", brand_or_program="Square One", distribution_type="direct",
         product_scope="standard_PPA", known_panel_source="Zurich Insurance Company (per brief [8])",
         quote_url="https://www.squareone.ca/car-insurance", public_phone_route="Square One public sales line",
         licensed_intermediary=None, requirements="", automation_notes="Direct for Ontario car per brief note under Zurich group.",
         status="unresolved"),
    dict(registry_id="td_insurance", brand_or_program="TD Insurance", distribution_type="direct",
         product_scope="standard_PPA", known_panel_source="TD General Insurance Company; Primmum; Security National",
         quote_url="https://www.tdinsurance.com/products-services/auto-insurance", public_phone_route="TD Insurance public sales line",
         licensed_intermediary=None, requirements="", automation_notes="Online, phone and affinity routes [16]. MVP ROUTE.",
         status="active_mvp"),
    dict(registry_id="the_personal", brand_or_program="The Personal", distribution_type="affinity",
         product_scope="affinity", known_panel_source="The Personal Insurance Company (Desjardins group)",
         quote_url="https://www.thepersonal.com/en/auto-insurance", public_phone_route="The Personal public sales line",
         licensed_intermediary=None, requirements="membership", automation_notes="Group/affinity quote route [18].",
         status="unresolved"),

    # ---- Broker / aggregator / branded-broker routes ----
    dict(registry_id="rates_ca", brand_or_program="Rates.ca", distribution_type="aggregator",
         product_scope="standard_PPA", known_panel_source="Broad panel, insurer API + industry-rater connectivity per brief [9]",
         quote_url="https://rates.ca/auto-insurance", public_phone_route=None,
         licensed_intermediary="Rates.ca", requirements="", automation_notes="Broad online comparison. MVP ROUTE.",
         status="active_mvp"),
    dict(registry_id="lowestrates_ca", brand_or_program="LowestRates.ca", distribution_type="aggregator",
         product_scope="standard_PPA", known_panel_source="CAA, Coachman, Economical, Gore, Pafco, Pembridge, SGI, Travelers, Zenith per brief [10]",
         quote_url="https://www.lowestrates.ca/auto-insurance", public_phone_route=None,
         licensed_intermediary="LowestRates.ca", requirements="",
         automation_notes=(
             "CONFIRMED duplicate of rates_ca, not just a suspected overlap — verified by manually "
             "running the identical applicant/coverage on both sites and getting identical results "
             "back, same backend with different branding on top. Not planned or attempted as its "
             "own route; rates_ca already covers this rate source."
         ),
         distinct_rate_source_id_override="rates_ca",
         source_citation_override=f"Manual side-by-side test by the applicant (identical results on both sites), {BUILD_START}",
         status="duplicate_rate_source"),
    dict(registry_id="surex", brand_or_program="Surex", distribution_type="broker",
         product_scope="standard_PPA", known_panel_source="Aviva, Intact, Jevco, Wawanesa, CAA, Coachman, Definity/Economical, Gore, Pafco, Pembridge, SGI, Travelers per brief [11]",
         quote_url="https://surex.com/auto-insurance", public_phone_route="Surex public callback route",
         licensed_intermediary="Surex", requirements="callback", automation_notes="Published carrier/MGA compensation disclosure.",
         status="unresolved"),
    dict(registry_id="thinkinsure", brand_or_program="ThinkInsure", distribution_type="broker",
         product_scope="standard_PPA", known_panel_source="Full RIBO-licensed carrier list — request explicitly",
         quote_url="https://thinkinsure.ca/auto-insurance/", public_phone_route="ThinkInsure public sales line",
         licensed_intermediary="ThinkInsure", requirements="human", automation_notes="Traditional independent broker — web intake plus advisor completion. Same human-mediated nature as local_independent_broker below.",
         status="unresolved"),
    dict(registry_id="onlia", brand_or_program="Onlia", distribution_type="broker",
         product_scope="standard_PPA", known_panel_source="Multiple carriers — capture actual returned insurer, not brokerage brand",
         quote_url="https://app.onlia.ca/#/auto/personal-info?Affinity_Group=Onlia", public_phone_route=None,
         licensed_intermediary="Onlia", requirements="",
         automation_notes=(
             "MVP ROUTE. Digital brokerage — self-generates a quote online, unlike a traditional "
             "independent broker. Real quoting-engine deep link confirmed (app.onlia.ca, separate from "
             "the marketing site). All 5 steps are now mapped: step 1 (Personal Info) from my own live "
             "DOM verification, steps 2-5 (Vehicle, Driver(s), main driver + contact, Get my quote) from "
             "my own real walkthrough of the full flow. Selectors past step 1 are best-effort from "
             "screenshots, not confirmed DOM ids — not yet run against the live site with real vault "
             "data. See worker/recipes/onlia.js."
         ),
         status="active_mvp"),
    dict(registry_id="scoop", brand_or_program="Scoop", distribution_type="broker",
         product_scope="standard_PPA", known_panel_source="Confirm full panel on live attempt",
         quote_url="https://insurancescoop.com/", public_phone_route="Scoop callback route",
         licensed_intermediary="Scoop", requirements="callback", automation_notes="Digital brokerage and callback workflow.",
         status="unresolved"),
    dict(registry_id="pc_insurance", brand_or_program="PC Insurance", distribution_type="broker",
         product_scope="standard_PPA", known_panel_source="Capture returned underwriter and eligibility discount",
         quote_url="https://www.pcinsurance.ca/auto-insurance", public_phone_route=None,
         licensed_intermediary="PC Insurance", requirements="", automation_notes="Branded digital brokerage.",
         status="unresolved"),
    dict(registry_id="inova", brand_or_program="Inova", distribution_type="broker",
         product_scope="standard_PPA", known_panel_source="Verify membership requirement and actual panel",
         quote_url="https://www.inova.ca/", public_phone_route=None,
         licensed_intermediary="Inova", requirements="membership", automation_notes="Membership-based brokerage route.",
         status="unresolved"),
    dict(registry_id="insurancehotline", brand_or_program="InsuranceHotline", distribution_type="broker",
         product_scope="standard_PPA", known_panel_source="Lead/broker-network route, not itself the underwriter",
         quote_url="https://www.insurancehotline.com/", public_phone_route=None,
         licensed_intermediary=None, requirements="", automation_notes="Lead-generation route; verify which broker ultimately handles it.",
         status="unresolved"),
    dict(registry_id="local_independent_broker", brand_or_program="Staebler Insurance", distribution_type="broker",
         product_scope="standard_PPA", known_panel_source="Full carrier list disclosed on request",
         quote_url="https://www.staebler.com/get-a-quote/",
         public_phone_route="Toll free 1-800-321-9187",
         licensed_intermediary="Staebler Insurance", requirements="human",
         automation_notes=(
             "MVP ROUTE, structurally different from the other MVP routes: a traditional "
             "independent broker doesn't return an instant automated quote — it hands over its "
             "carrier list and quote results on request, a human-mediated exchange. Confirmed "
             "directly by Staebler's own site, which describes this explicitly as a 3-step process "
             "(submit form -> get paired with a broker who calls -> broker compares and presents "
             "options). Recipe fills the lead form (name/email/phone/message) then stops at a "
             "human checkpoint before the final Submit click — see worker/recipes/"
             "local_independent_broker.js. Correct terminal status is manual_handoff/"
             "callback_required, never a fabricated firm quote."
         ),
         status="active_mvp"),

    # ---- MGA / program / specialty discovery ----
    dict(registry_id="hagerty", brand_or_program="Hagerty (collector)", distribution_type="MGA_program",
         product_scope="collector", known_panel_source="Administered separately, underwritten by Aviva per brief [13]",
         quote_url="https://www.hagerty.ca/insurance", public_phone_route="Hagerty public sales line",
         licensed_intermediary=None, requirements="", automation_notes="Only applicable if vehicle/household meet program rules — not a daily-driver substitute.",
         status="unresolved"),
    dict(registry_id="agile", brand_or_program="Agile Underwriting", distribution_type="MGA_program",
         product_scope="unknown", known_panel_source="Discovery lead from broker disclosures per brief [11][13]",
         quote_url=None, public_phone_route=None, licensed_intermediary="Via broker",
         requirements="human", automation_notes="Count only after verifying it accepts an individual Ontario PPA risk relevant to my profile.",
         status="unresolved"),
    dict(registry_id="april_canada", brand_or_program="APRIL Canada", distribution_type="MGA_program",
         product_scope="unknown", known_panel_source="Discovery lead from broker disclosures",
         quote_url=None, public_phone_route=None, licensed_intermediary="Via broker",
         requirements="human", automation_notes="Verify PPA relevance before counting.", status="unresolved"),
    dict(registry_id="burns_wilcox", brand_or_program="Burns & Wilcox", distribution_type="MGA_program",
         product_scope="unknown", known_panel_source="Discovery lead from broker disclosures",
         quote_url=None, public_phone_route=None, licensed_intermediary="Via broker",
         requirements="human", automation_notes="Verify PPA relevance before counting.", status="unresolved"),
    dict(registry_id="cambrian_special_risks", brand_or_program="Cambrian Special Risks", distribution_type="MGA_program",
         product_scope="unknown", known_panel_source="Discovery lead from broker disclosures",
         quote_url=None, public_phone_route=None, licensed_intermediary="Via broker",
         requirements="human", automation_notes="Verify PPA relevance before counting.", status="unresolved"),
    dict(registry_id="milnco", brand_or_program="Milnco", distribution_type="MGA_program",
         product_scope="unknown", known_panel_source="Discovery lead from broker disclosures",
         quote_url=None, public_phone_route=None, licensed_intermediary="Via broker",
         requirements="human", automation_notes="Verify PPA relevance before counting.", status="unresolved"),
    dict(registry_id="special_risk", brand_or_program="Special Risk", distribution_type="MGA_program",
         product_scope="unknown", known_panel_source="Discovery lead from broker disclosures",
         quote_url=None, public_phone_route=None, licensed_intermediary="Via broker",
         requirements="human", automation_notes="Verify PPA relevance before counting.", status="unresolved"),
    dict(registry_id="nonstandard_echelon_jevco_pafco_coachman", brand_or_program="Non-standard auto (Echelon/Jevco/Pafco/Coachman)",
         distribution_type="MGA_program", product_scope="nonstandard_PPA",
         known_panel_source="Test through licensed broker routes when profile fits",
         quote_url=None, public_phone_route=None, licensed_intermediary="Via broker",
         requirements="human", automation_notes="Only relevant if standard-market routes decline or rate poorly.",
         status="unresolved"),
    dict(registry_id="hnw_chubb_pure", brand_or_program="High-net-worth (Chubb/PURE)", distribution_type="MGA_program",
         product_scope="high_net_worth", known_panel_source="Verify through an appointed broker",
         quote_url=None, public_phone_route=None, licensed_intermediary="Via appointed broker",
         requirements="human", automation_notes="Do not count a market I cannot access.", status="unresolved"),
    dict(registry_id="facility_association", brand_or_program="Facility Association (residual)", distribution_type="residual",
         product_scope="unknown", known_panel_source="Fallback for otherwise hard-to-place risks",
         quote_url=None, public_phone_route=None, licensed_intermediary="Via licensed intermediary",
         requirements="human", automation_notes=OUT_OF_SCOPE_ROUTES["facility_association"],
         status="out_of_scope"),
    dict(registry_id="ontario_mutuals", brand_or_program="Ontario Mutuals (locator)", distribution_type="mutual",
         product_scope="unknown", known_panel_source="Commonwell, Gore, Heartland, Peel, Portage, Wawanesa and others per Appendix A",
         quote_url="https://www.ontariomutuals.ca/", public_phone_route=None,
         licensed_intermediary="Specific mutual via locator", requirements="human",
         automation_notes=OUT_OF_SCOPE_ROUTES["ontario_mutuals"],
         status="out_of_scope"),
]

# Appendix A regulatory seed — the underwriting-layer discovery list, kept as a
# separate reference table (not queryable routes themselves). Used for
# deduplication and to catch groups no route above currently reaches.
UNDERWRITING_GROUPS_SEED = [
    dict(insurer_group="AIG", legal_entities="AIG Insurance Company of Canada", validation_note="Specialty/commercial broker; validate PPA relevance"),
    dict(insurer_group="Allstate", legal_entities="Allstate Insurance Company of Canada; Esurance Insurance Company of Canada; Pafco Insurance Company; Pembridge Insurance Company", validation_note="Allstate direct/agent; Pafco and Pembridge broker; validate Esurance"),
    dict(insurer_group="Aviva", legal_entities="Aviva General Insurance Company; Aviva Insurance Company of Canada; S&Y Insurance Company; Scottish & York Insurance Co. Limited; Traders General Insurance Company", validation_note="Direct, RBC, broker and program routes; dedupe and validate legacy entities"),
    dict(insurer_group="Beneva", legal_entities="Unica Insurance Inc.", validation_note="Broker route"),
    dict(insurer_group="CAA", legal_entities="CAA Insurance Company; Echelon Insurance", validation_note="CAA direct/broker; Echelon broker and non-standard"),
    dict(insurer_group="Chubb", legal_entities="Chubb Insurance Company of Canada", validation_note="High-net-worth or specialty broker"),
    dict(insurer_group="Co-op", legal_entities="COSECO Insurance Company; CUMIS General Insurance Company; Co-operators General Insurance Company; The Sovereign General Insurance Company", validation_note="Co-operators web/agent; affinity and specialty entities need validation"),
    dict(insurer_group="Commonwell", legal_entities="The Commonwell Mutual Insurance Group", validation_note="Mutual and broker/agent route"),
    dict(insurer_group="Continental", legal_entities="Continental Casualty Company", validation_note="Specialty/commercial broker; validate PPA relevance"),
    dict(insurer_group="Definity", legal_entities="Definity Insurance Company; Sonnet Insurance Company", validation_note="Definity/Economical broker; Sonnet direct"),
    dict(insurer_group="Desjardins", legal_entities="Certas Direct Insurance Company; Certas Home and Auto Insurance Company; The Personal Insurance Company", validation_note="Desjardins web/agent; The Personal affinity"),
    dict(insurer_group="Economical", legal_entities="Economical Mutual Insurance Company", validation_note="Broker route; map current legal entity/program"),
    dict(insurer_group="FA", legal_entities="Facility Association", validation_note="Residual-market route through licensed intermediary"),
    dict(insurer_group="FMRe", legal_entities="Farm Mutual Reinsurance Plan Inc. (on behalf of Ontario Mutuals)", validation_note="Ontario Mutuals locator and specific mutual validation"),
    dict(insurer_group="Gore", legal_entities="Gore Mutual Insurance Company", validation_note="Broker route"),
    dict(insurer_group="Hartford", legal_entities="Hartford Fire Insurance Company", validation_note="Specialty/commercial broker; validate PPA relevance"),
    dict(insurer_group="Heartland", legal_entities="Heartland Farm Mutual Inc.", validation_note="Mutual/local agent or broker"),
    dict(insurer_group="Intact", legal_entities="Belair Insurance Company Inc.; The Guarantee Company of North America; Intact Insurance Company; Jevco Insurance Company; Novex Insurance Company; Royal & SunAlliance Insurance Company of Canada; Unifund Assurance Company; Western Assurance Company", validation_note="belairdirect direct; Intact and Jevco broker; validate legacy/affinity entities"),
    dict(insurer_group="Liberty", legal_entities="Liberty Mutual Insurance Company", validation_note="Specialty/commercial broker; validate PPA relevance"),
    dict(insurer_group="Northbridge", legal_entities="Federated Insurance Company of Canada; Northbridge General Insurance Corporation; Verassure Insurance Company; Zenith Insurance Company", validation_note="Northbridge and Zenith broker; validate Federated/Verassure scope"),
    dict(insurer_group="Optimum", legal_entities="Optimum Insurance Company Inc.", validation_note="Broker route"),
    dict(insurer_group="PURE", legal_entities="PURE Insurance", validation_note="High-net-worth broker"),
    dict(insurer_group="Peel", legal_entities="Peel Mutual Insurance Company", validation_note="Mutual/local agent or broker"),
    dict(insurer_group="Portage", legal_entities="The Portage la Prairie Mutual Insurance Company", validation_note="Broker route"),
    dict(insurer_group="SGI", legal_entities="Coachman Insurance Company; SGI CANADA Insurance Services Ltd.", validation_note="Broker route; Coachman non-standard"),
    dict(insurer_group="Sompo", legal_entities="Endurance Specialty Insurance Ltd.; Sompo Japan Insurance Inc.", validation_note="Specialty/commercial broker; validate PPA relevance"),
    dict(insurer_group="TD", legal_entities="Primmum Insurance Company; Security National Insurance Company; TD General Insurance Company", validation_note="TD online, phone and affinity routes"),
    dict(insurer_group="Tokio", legal_entities="Tokio Marine and Nichido Fire Insurance Company Limited", validation_note="Specialty/commercial broker; validate PPA relevance"),
    dict(insurer_group="Travelers", legal_entities="The Dominion of Canada General Insurance Company", validation_note="Broker route"),
    dict(insurer_group="Wawanesa", legal_entities="The Wawanesa Mutual Insurance Company", validation_note="Broker route"),
    dict(insurer_group="XL", legal_entities="XL Specialty Insurance Company", validation_note="Specialty/commercial broker; validate PPA relevance"),
    dict(insurer_group="Zurich", legal_entities="Zurich Insurance Company", validation_note="Square One direct for Ontario car; specialty broker routes may differ"),
]


def build():
    rows = []
    for r in ROUTES:
        row = dict(r)
        # Per-row overrides win when a route has confirmed, specific evidence
        # (e.g. lowestrates_ca's manually-verified duplicate) instead of the
        # generic default applied to everything else.
        row["distinct_rate_source_id"] = row.pop("distinct_rate_source_id_override", row["registry_id"])
        default_citation = "Ontario All-Quote Agent Challenge participant brief, checked " + SEED_DATE
        row["source_citation"] = row.pop("source_citation_override", default_citation)
        row["last_verified_at"] = BUILD_START if row["status"] in ("active_mvp", "duplicate_rate_source") else None
        rows.append(row)
    return rows


def main():
    out_dir = Path(__file__).parent
    rows = build()

    (out_dir / "market_registry.json").write_text(json.dumps({
        "generated_from": "docs/../Ontario All Quote Agent Hackathon Brief - August 8 Update.pdf, Appendix A/B",
        "seed_date": SEED_DATE,
        "build_start_date": BUILD_START,
        "mvp_routes": sorted(MVP_ROUTES),
        "routes": rows,
        "underwriting_groups_seed": UNDERWRITING_GROUPS_SEED,
    }, indent=2), encoding="utf-8")

    fieldnames = ["registry_id", "brand_or_program", "distribution_type", "product_scope",
                  "known_panel_source", "quote_url", "public_phone_route", "licensed_intermediary",
                  "requirements", "distinct_rate_source_id", "automation_notes", "status",
                  "last_verified_at", "source_citation"]
    with (out_dir / "market_registry.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fieldnames})

    print(f"Wrote {len(rows)} routes to market_registry.json and market_registry.csv")


if __name__ == "__main__":
    main()

import { HUMAN_REVIEW_LABELS } from "../domain/index.js";
import type { ExperimentReport } from "./schema.js";

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/([`*_{}\[\]<>#+.!|\-])/g, "\\$1")
    .replace(/\r\n|\r|\n/g, "<br>");
}

function shown(value: string | number | undefined): string {
  return value === undefined ? "non disponible" : escapeMarkdown(String(value));
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "aucun" : values.map(escapeMarkdown).join(", ");
}

export function renderExperimentReportMarkdown(report: ExperimentReport): string {
  const lines: string[] = [
    "# Rapport d’expérience",
    "",
    `> État : ${report.completeness.complete ? "COMPLÈTE" : "INCOMPLÈTE"}`,
    ...(!report.completeness.complete
      ? [`> Raisons : ${list(report.completeness.reasons)}`]
      : []),
    "",
    "## Source",
    "",
    `- Plan : ${escapeMarkdown(report.plan.id)}`,
    `- Fingerprint du plan : ${escapeMarkdown(report.plan.fingerprint)}`,
    `- Référence du plan : ${escapeMarkdown(report.source.planRef)}`,
    `- PlannedRun : ${report.plan.plannedRunCount}`,
    ...(report.source.checkpoint ? [
      `- Checkpoint : ${escapeMarkdown(report.source.checkpoint.ref)}`,
      `- Séquence checkpoint : ${report.source.checkpoint.sequence}`,
      `- Fingerprint état : ${escapeMarkdown(report.source.checkpoint.stateFingerprint)}`,
      `- Statut orchestration : ${escapeMarkdown(report.source.checkpoint.executionStatus)}`,
    ] : ["- Checkpoint : aucun"]),
    "",
    "## État de l’expérience",
    "",
    `- Complète : ${report.completeness.complete ? "oui" : "non"}`,
    `- Raisons de non-complétude : ${list(report.completeness.reasons)}`,
    "",
    "## Synthèse technique",
    "",
    "| Statut technique | Nombre | PlannedRun sources |",
    "| --- | ---: | --- |",
    ...Object.entries(report.summary.technicalStatuses).map(([status, aggregate]) => (
      `| ${escapeMarkdown(status)} | ${aggregate.count} | ${list(aggregate.plannedRunIds)} |`
    )),
    "",
    `Durées connues : ${report.summary.durations.knownRunCount} run(s), total factuel ${report.summary.durations.totalMs === null ? "non disponible" : `${report.summary.durations.totalMs} ms`}.`,
    "",
    "| PlannedRun | Durée (ms) | Manifest source |",
    "| --- | ---: | --- |",
    ...report.summary.durations.observations.map((observation) => (
      `| ${escapeMarkdown(observation.plannedRunId)} | ${observation.durationMs} | ${escapeMarkdown(observation.sourceManifestRef)} |`
    )),
    ...(report.summary.durations.observations.length === 0 ? ["| aucun | non disponible | non disponible |"] : []),
    "",
    `Runs avec état workspace connu : ${report.summary.changedFiles.knownRunCount}.`,
    `Runs avec modifications : ${report.summary.changedFiles.runsWithChanges.count} (${list(report.summary.changedFiles.runsWithChanges.plannedRunIds)}).`,
    `Runs sans modification constatée : ${report.summary.changedFiles.runsWithoutChanges.count} (${list(report.summary.changedFiles.runsWithoutChanges.plannedRunIds)}).`,
    `Union des fichiers modifiés : ${list(report.summary.changedFiles.union.map(({ path }) => path))}.`,
    "",
    "## Revue humaine",
    "",
    "| PlannedRun | Décision humaine courante | Origine | Reviewer | Date | Commentaire humain |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.runs.map((run) => (
      `| ${escapeMarkdown(run.plannedRunId)} | ${escapeMarkdown(HUMAN_REVIEW_LABELS[run.humanReview.status])} | ${escapeMarkdown(run.humanReview.origin)} | ${shown(run.humanReview.reviewer)} | ${shown(run.humanReview.reviewedAt)} | ${shown(run.humanReview.comment)} |`
    )),
    "",
    `Actions humaines enregistrées : ${report.summary.reviewActions.count}.`,
    "",
    "## Runs à vérifier",
    "",
    ...(report.summary.pendingReviewRunIds.length === 0
      ? ["Aucun run avec le statut humain « À vérifier ». "]
      : report.runs.filter(({ humanReview }) => humanReview.status === "pending_review").map((run) => (
        `- ${escapeMarkdown(run.plannedRunId)} — TestCase ${escapeMarkdown(run.testCase.id)}, ${escapeMarkdown(run.variant)}, répétition ${run.repetition}, statut technique ${escapeMarkdown(run.technicalStatus)}, attempt ${run.attempt}, manifest ${run.manifest ? escapeMarkdown(run.manifest.ref) : "non disponible"}`
      ))),
    "",
    "## Runs",
    "",
    "| PlannedRun | TestCase | Type | Variante | Répétition | Attempt | Statut technique | Exit code | Durée (ms) | Manifest |",
    "| --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | --- |",
    ...report.runs.map((run) => (
      `| ${escapeMarkdown(run.plannedRunId)} | ${escapeMarkdown(run.testCase.id)} | ${escapeMarkdown(run.testCase.kind)} | ${escapeMarkdown(run.variant)} | ${run.repetition} | ${run.attempt} | ${escapeMarkdown(run.technicalStatus)} | ${shown(run.exitCode)} | ${shown(run.durationMs)} | ${run.manifest ? escapeMarkdown(run.manifest.ref) : "non disponible"} |`
    )),
    "",
    "### Historique des attempts",
    "",
    ...report.runs.flatMap((run) => [
      `#### ${escapeMarkdown(run.plannedRunId)}`,
      "",
      ...(run.attempts.length === 0 ? ["Aucune attempt archivée."] : run.attempts.map((attempt) => (
        `- Attempt ${attempt.attempt} : ${escapeMarkdown(attempt.status)} ; started ${escapeMarkdown(attempt.startedRef)} ; manifest ${attempt.manifestRef ? escapeMarkdown(attempt.manifestRef) : "non disponible"}`
      ))),
      "",
    ]),
    "## Comparaisons BASELINE / AVEC PROMPT",
    "",
    ...report.comparisons.flatMap((entry) => [
      `### ${escapeMarkdown(entry.experimentId)} / ${escapeMarkdown(entry.testCaseId)} / répétition ${entry.repetition}`,
      "",
      `- Paire terminale : ${entry.pairTerminal ? "oui" : "non"}`,
      `- Faits comparatifs complets : ${entry.factsComplete ? "oui" : "non"}`,
      `- Faits manquants : ${list(entry.missingFacts)}`,
      `- BASELINE : ${escapeMarkdown(entry.baseline.plannedRunId)}, statut ${escapeMarkdown(entry.baseline.technicalStatus)}, exit code ${shown(entry.baseline.exitCode)}, durée ${shown(entry.baseline.durationMs)} ms`,
      `- AVEC PROMPT : ${escapeMarkdown(entry.treatment.plannedRunId)}, statut ${escapeMarkdown(entry.treatment.technicalStatus)}, exit code ${shown(entry.treatment.exitCode)}, durée ${shown(entry.treatment.durationMs)} ms`,
      `- Différence de durée AVEC PROMPT moins BASELINE : ${shown(entry.treatmentMinusBaselineMs)}${entry.treatmentMinusBaselineMs === undefined ? "" : " ms"}`,
      ...(entry.changedFiles ? [
        `- Fichiers partagés : ${list(entry.changedFiles.shared)}`,
        `- Fichiers BASELINE uniquement : ${list(entry.changedFiles.baselineOnly)}`,
        `- Fichiers AVEC PROMPT uniquement : ${list(entry.changedFiles.treatmentOnly)}`,
      ] : ["- Comparaison des fichiers : non disponible"]),
      "",
    ]),
    "## Evidence et métriques",
    "",
    "| Type Evidence | Nombre | Sources |",
    "| --- | ---: | --- |",
    ...report.summary.evidenceTypes.map((entry) => (
      `| ${escapeMarkdown(entry.type)} | ${entry.count} | ${list(entry.sources.map(({ plannedRunId, evidenceIndex }) => `${plannedRunId}#${evidenceIndex}`))} |`
    )),
    ...(report.summary.evidenceTypes.length === 0 ? ["| aucune | 0 | aucune |"] : []),
    "",
    "| Métrique | Unité | Observations | Somme | Min | Max |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...report.summary.metrics.map((metric) => (
      `| ${escapeMarkdown(metric.name)} | ${metric.unit === null ? "non spécifiée" : escapeMarkdown(metric.unit)} | ${metric.observationCount} | ${metric.sum} | ${metric.min} | ${metric.max} |`
    )),
    ...(report.summary.metrics.length === 0 ? ["| aucune | non spécifiée | 0 | non disponible | non disponible | non disponible |"] : []),
    "",
    "## Traçabilité",
    "",
    `- Plan : ${escapeMarkdown(report.source.planRef)}`,
    ...(report.source.checkpoint ? [`- Checkpoint : ${escapeMarkdown(report.source.checkpoint.ref)}`] : []),
    ...report.runs.flatMap((run) => [
      ...(run.manifest ? [`- Manifest ${escapeMarkdown(run.plannedRunId)} : ${escapeMarkdown(run.manifest.ref)} (${escapeMarkdown(run.manifest.fingerprint)})`] : []),
      ...run.humanReview.history.map((action) => (
        `- Action humaine ${escapeMarkdown(run.plannedRunId)}#${action.sequence} : ${escapeMarkdown(action.sourceRef)} (${escapeMarkdown(action.recordFingerprint)})`
      )),
    ]),
    "",
  ];
  return lines.join("\n");
}

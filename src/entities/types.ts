export interface ExtractedTriple {
  subject: string;
  /** Entity type for the subject node (e.g. "person", "technology"). Defaults to "concept". */
  subjectType?: string;
  predicate: string;
  object: string;
  /** Entity type for the object node (e.g. "person", "technology"). Defaults to "concept". */
  objectType?: string;
  confidence: number;
  contextSnippet?: string;
}

export interface ExtractionResult {
  triples: ExtractedTriple[];
  provider: string;
  providerVersion: string;
  contentType: "handoff" | "note" | "task";
  contentId: string;
  durationMs: number;
}

export interface EntityExtractor {
  readonly provider: string;
  readonly version: string;

  extract(
    content: string,
    contentType: "handoff" | "note" | "task",
    contentId: string
  ): Promise<ExtractionResult>;

  /** Health check — can this provider run right now? */
  available(): Promise<boolean>;
}

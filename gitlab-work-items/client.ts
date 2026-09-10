/** A work item returned by GitLab's REST issues API. */
export interface GitLabWorkItem {
  id: number;
  iid: number;
  type: string;
  title: string;
  description: string;
  state: string;
  webUrl: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

/** A hierarchy reference returned by GitLab's GraphQL API. */
export interface GitLabWorkItemReference {
  id: number;
  gid: string;
  iid: number;
  title: string;
  webUrl: string;
}

/** Explicitly distinguishes unreadable hierarchy from an empty hierarchy. */
export type GitLabHierarchy =
  | {
    status: "available";
    parent: GitLabWorkItemReference | null;
    children: GitLabWorkItemReference[];
    complete: boolean;
    nextCursor: string | null;
    pagesFetched: number;
  }
  | { status: "unavailable"; reason: string }
  | { status: "not-requested" };

/** Bounded REST pagination and supported work-item filters. */
export interface GitLabListArguments {
  project: string;
  type: "all" | "issue" | "task" | "incident";
  state: "all" | "opened" | "closed";
  page: number;
  perPage: number;
  maxPages: number;
  /** Match every named label. An empty array leaves the list unfiltered. */
  labels?: string[];
}

/** Full description plus optional bounded parent/child retrieval. */
export interface GitLabGetArguments {
  project: string;
  iid: number;
  includeHierarchy: boolean;
  perPage: number;
  maxPages: number;
  after?: string;
}

/** List data and whether further REST pages remain. */
export interface GitLabListResult {
  project: string;
  items: GitLabWorkItem[];
  pagination: {
    complete: boolean;
    nextPage: number | null;
    pagesFetched: number;
  };
}

/** Work-item detail with explicit hierarchy availability. */
export interface GitLabGetResult {
  project: string;
  item: GitLabWorkItem;
  hierarchy: GitLabHierarchy;
}

/** Create a standalone issue, task or incident. Link a parent separately. */
export interface GitLabCreateArguments {
  project: string;
  type: "issue" | "task" | "incident";
  title: string;
  description?: string;
  labels?: string[];
}

/** Apply label deltas without replacing unrelated labels. */
export interface GitLabUpdateArguments {
  project: string;
  iid: number;
  title?: string;
  description?: string;
  addLabels?: string[];
  removeLabels?: string[];
  state?: "opened" | "closed";
  expectedId?: number;
}

/** Delete only the freshly read work item with this global numeric ID. */
export interface GitLabDeleteArguments {
  project: string;
  iid: number;
  expectedId: number;
}

/** Set a same-project parent or pass null to remove the parent. */
export interface GitLabSetParentArguments {
  project: string;
  iid: number;
  parentIid: number | null;
  expectedId?: number;
}

/** An authoritative work-item response returned by a successful write. */
export interface GitLabMutationResult {
  project: string;
  item: GitLabWorkItem;
}

export interface GitLabDeleteResult {
  project: string;
  id: number;
  iid: number;
  deleted: true;
}

export interface GitLabSetParentResult {
  project: string;
  item: GitLabWorkItemReference;
  parent: GitLabWorkItemReference | null;
}

const hierarchyQuery = `query WorkItemHierarchy(
  $project: ID!, $iid: String!, $first: Int!, $after: String
) {
  project(fullPath: $project) {
    workItems(iid: $iid, first: 1) {
      nodes {
        id iid title webUrl
        widgets(onlyTypes: [HIERARCHY]) {
          type
          ... on WorkItemWidgetHierarchy {
            parent { id iid title webUrl }
            children(first: $first, after: $after) {
              nodes { id iid title webUrl }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    }
  }
}`;

const setParentMutation =
  `mutation SetWorkItemParent($input: WorkItemUpdateInput!) {
  workItemUpdate(input: $input) {
    errors
    workItem {
      id iid title webUrl
      widgets(onlyTypes: [HIERARCHY]) {
        type
        ... on WorkItemWidgetHierarchy {
          parent { id iid title webUrl }
        }
      }
    }
  }
}`;

const unknownMutationOutcome =
  "GitLab mutation outcome is unknown; inspect the current GitLab state before any retry.";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitLab returned an invalid object.");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("GitLab returned an invalid string.");
  }
  return value;
}

function positiveInteger(value: unknown): number {
  const number = typeof value === "string" && /^[1-9][0-9]*$/.test(value)
    ? Number(value)
    : value;
  if (
    typeof number !== "number" || !Number.isSafeInteger(number) || number < 1
  ) {
    throw new Error("Expected a safe positive integer.");
  }
  return number;
}

function boundedInteger(value: number, maximum: number): number {
  const result = positiveInteger(value);
  if (result > maximum) throw new Error("Pagination limit is out of range.");
  return result;
}

function projectPath(value: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new Error("A GitLab project path is required.");
  }
  return value;
}

function labelNames(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((label) =>
      typeof label !== "string" || !label.trim() ||
      label !== label.trim() || /[,\r\n]/.test(label)
    ) || new Set(value).size !== value.length
  ) {
    throw new Error(
      "Labels must be distinct non-empty names without commas or surrounding whitespace.",
    );
  }
  return value as string[];
}

function titleValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("A non-empty work-item title is required.");
  }
  return value;
}

function descriptionValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("A work-item description must be a string.");
  }
  // GitLab removes CR before interpreting line-based quick actions. Reject
  // command-shaped lines conservatively, including inside fenced examples.
  if (/^[\t ]*\/[a-z][a-z0-9_-]*(?=\s|$)/im.test(value.replace(/\r/g, ""))) {
    throw new Error(
      "Description contains a possible GitLab quick-action line; use inline code for literal examples. No write was sent.",
    );
  }
  return value;
}

function workItem(value: unknown): GitLabWorkItem {
  const item = record(value);
  if (
    !Array.isArray(item.labels) ||
    !item.labels.every((v) => typeof v === "string")
  ) {
    throw new Error("GitLab returned invalid labels.");
  }
  const type = string(item.issue_type);
  if (!type) throw new Error("GitLab did not return a work-item type.");
  return {
    id: positiveInteger(item.id),
    iid: positiveInteger(item.iid),
    type,
    title: string(item.title),
    description: item.description === null ? "" : string(item.description),
    state: string(item.state),
    webUrl: string(item.web_url),
    labels: item.labels as string[],
    createdAt: string(item.created_at),
    updatedAt: string(item.updated_at),
  };
}

function reference(value: unknown): GitLabWorkItemReference {
  const item = record(value);
  const gid = string(item.id);
  const match = /^gid:\/\/gitlab\/WorkItem\/([1-9][0-9]*)$/.exec(gid);
  if (!match) {
    throw new Error("GitLab returned an invalid work-item global ID.");
  }
  return {
    id: positiveInteger(match[1]),
    gid,
    iid: positiveInteger(item.iid),
    title: string(item.title),
    webUrl: string(item.webUrl),
  };
}

/** Requests stay on the configured HTTPS host, never follow redirects or retry writes. */
export class GitLabWorkItemsClient {
  private readonly origin: string;
  private readonly token: string;

  /** Accept a hostname with an optional port and a token with suitable GitLab API access. */
  constructor(host: string, token: string) {
    if (
      typeof host !== "string" || !/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(host)
    ) {
      throw new Error(
        "GitLab host must be a hostname with an optional HTTPS port.",
      );
    }
    try {
      const url = new URL(`https://${host}`);
      if (
        !url.hostname.split(".").every((part) =>
          /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(part)
        )
      ) {
        throw new Error();
      }
      this.origin = url.origin;
    } catch {
      throw new Error(
        "GitLab host must be a hostname with an optional HTTPS port.",
      );
    }
    if (typeof token !== "string" || !token || /[\r\n]/.test(token)) {
      throw new Error("A valid GitLab token is required.");
    }
    this.token = token;
  }

  private async request(
    url: URL,
    body?: Record<string, unknown>,
  ): Promise<{ response: Response; data: unknown }> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: {
          "PRIVATE-TOKEN": this.token,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error("GitLab request failed or timed out.");
    }
    if (!response.ok) {
      // Cleanup must not replace the safe HTTP error with transport details.
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitLab request failed (HTTP ${response.status}).`);
    }
    try {
      return { response, data: await response.json() };
    } catch {
      throw new Error("GitLab returned invalid JSON.");
    }
  }

  private issueUrl(project: string, iid?: number): URL {
    return new URL(
      `/api/v4/projects/${encodeURIComponent(project)}/issues${
        iid === undefined ? "" : `/${iid}`
      }`,
      this.origin,
    );
  }

  private async readItem(
    project: string,
    iid: number,
  ): Promise<GitLabWorkItem> {
    const { data } = await this.request(this.issueUrl(project, iid));
    const item = workItem(data);
    if (item.iid !== iid) {
      throw new Error("GitLab returned a different work item.");
    }
    return item;
  }

  private async mutate(
    url: URL,
    method: "POST" | "PUT" | "DELETE",
    expectedStatus: number,
    body?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          "PRIVATE-TOKEN": this.token,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(unknownMutationOutcome);
    }
    if (response.status !== expectedStatus) {
      await response.body?.cancel().catch(() => undefined);
      if (
        response.status >= 400 && response.status < 500 &&
        response.status !== 408
      ) {
        throw new Error(
          `GitLab mutation was rejected (HTTP ${response.status}).`,
        );
      }
      throw new Error(unknownMutationOutcome);
    }
    if (expectedStatus === 204) return undefined;
    try {
      return await response.json();
    } catch {
      throw new Error(unknownMutationOutcome);
    }
  }

  /** Create one issue, task or incident with a single POST and no retry. */
  async create(args: GitLabCreateArguments): Promise<GitLabMutationResult> {
    const project = projectPath(args.project);
    if (!["issue", "task", "incident"].includes(args.type)) {
      throw new Error("Unsupported GitLab work-item type.");
    }
    const body: Record<string, unknown> = {
      issue_type: args.type,
      title: titleValue(args.title),
    };
    if (args.description !== undefined) {
      body.description = descriptionValue(args.description);
    }
    if (args.labels !== undefined) {
      body.labels = labelNames(args.labels).join(",");
    }
    const data = await this.mutate(this.issueUrl(project), "POST", 201, body);
    try {
      const item = workItem(data);
      if (
        item.type !== args.type || item.state !== "opened" ||
        (args.labels !== undefined &&
          !args.labels.every((label) => item.labels.includes(label)))
      ) throw new Error();
      return { project, item };
    } catch {
      throw new Error(unknownMutationOutcome);
    }
  }

  /** Update content, label deltas and open/closed state in one PUT. */
  async update(args: GitLabUpdateArguments): Promise<GitLabMutationResult> {
    const project = projectPath(args.project);
    const iid = positiveInteger(args.iid);
    const expectedId = args.expectedId === undefined
      ? undefined
      : positiveInteger(args.expectedId);
    const body: Record<string, unknown> = {};
    if (args.title !== undefined) body.title = titleValue(args.title);
    if (args.description !== undefined) {
      body.description = descriptionValue(args.description);
    }
    const added = args.addLabels === undefined
      ? []
      : labelNames(args.addLabels);
    const removed = args.removeLabels === undefined
      ? []
      : labelNames(args.removeLabels);
    if (added.some((label) => removed.includes(label))) {
      throw new Error("The same label cannot be added and removed together.");
    }
    if (added.length > 0) body.add_labels = added.join(",");
    if (removed.length > 0) body.remove_labels = removed.join(",");
    if (args.state !== undefined) {
      if (!["opened", "closed"].includes(args.state)) {
        throw new Error("Work-item state must be opened or closed.");
      }
      body.state_event = args.state === "opened" ? "reopen" : "close";
    }
    if (Object.keys(body).length === 0) {
      throw new Error("At least one work-item change is required.");
    }
    let prior: GitLabWorkItem | undefined;
    if (expectedId !== undefined) {
      prior = await this.readItem(project, iid);
      if (prior.id !== expectedId) {
        throw new Error(
          "Work-item identity does not match expectedId; no write was sent.",
        );
      }
    }
    const data = await this.mutate(
      this.issueUrl(project, iid),
      "PUT",
      200,
      body,
    );
    try {
      const item = workItem(data);
      if (
        item.iid !== iid ||
        (expectedId !== undefined && item.id !== expectedId) ||
        (prior !== undefined && item.type !== prior.type) ||
        !["opened", "closed"].includes(item.state) ||
        (args.state !== undefined && item.state !== args.state) ||
        !added.every((label) => item.labels.includes(label)) ||
        removed.some((label) => item.labels.includes(label))
      ) throw new Error();
      return { project, item };
    } catch {
      throw new Error(unknownMutationOutcome);
    }
  }

  /** Freshly verify identity and timestamp, then accept only a conditional DELETE's 204. */
  async delete(args: GitLabDeleteArguments): Promise<GitLabDeleteResult> {
    const project = projectPath(args.project);
    const iid = positiveInteger(args.iid);
    const expectedId = positiveInteger(args.expectedId);
    const item = await this.readItem(project, iid);
    if (item.id !== expectedId) {
      throw new Error(
        "Work-item identity does not match expectedId; no write was sent.",
      );
    }
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
        .test(item.updatedAt) ||
      !Number.isFinite(Date.parse(item.updatedAt))
    ) {
      throw new Error(
        "GitLab did not return a valid update timestamp; no delete was sent.",
      );
    }
    await this.mutate(this.issueUrl(project, iid), "DELETE", 204, undefined, {
      "If-Unmodified-Since": item.updatedAt,
    });
    return { project, id: item.id, iid: item.iid, deleted: true };
  }

  /** Resolve project-scoped IIDs before setting or removing a parent with GraphQL. */
  async setParent(
    args: GitLabSetParentArguments,
  ): Promise<GitLabSetParentResult> {
    const project = projectPath(args.project);
    const iid = positiveInteger(args.iid);
    const parentIid = args.parentIid === null
      ? null
      : positiveInteger(args.parentIid);
    const expectedId = args.expectedId === undefined
      ? undefined
      : positiveInteger(args.expectedId);
    if (parentIid === iid) {
      throw new Error("A work item cannot be its own parent.");
    }
    const target = await this.readItem(project, iid);
    if (expectedId !== undefined && target.id !== expectedId) {
      throw new Error(
        "Work-item identity does not match expectedId; no write was sent.",
      );
    }
    const parent = parentIid === null
      ? null
      : await this.readItem(project, parentIid);
    const data = await this.mutate(
      new URL("/api/graphql", this.origin),
      "POST",
      200,
      {
        query: setParentMutation,
        variables: {
          input: {
            id: `gid://gitlab/WorkItem/${target.id}`,
            hierarchyWidget: {
              parentId: parent === null
                ? null
                : `gid://gitlab/WorkItem/${parent.id}`,
            },
          },
        },
      },
    );
    try {
      const envelope = record(data);
      if (
        envelope.errors !== undefined &&
        (!Array.isArray(envelope.errors) || envelope.errors.length > 0)
      ) throw new Error();
      const payload = record(record(envelope.data).workItemUpdate);
      if (!Array.isArray(payload.errors) || payload.errors.length > 0) {
        throw new Error();
      }
      const root = record(payload.workItem);
      const item = reference(root);
      if (item.id !== target.id || item.iid !== target.iid) throw new Error();
      if (!Array.isArray(root.widgets)) throw new Error();
      const widgets = root.widgets.map(record).filter((widget) =>
        widget.type === "HIERARCHY"
      );
      if (widgets.length !== 1) throw new Error();
      const returnedParent = widgets[0].parent === null
        ? null
        : reference(widgets[0].parent);
      if (
        parent === null
          ? returnedParent !== null
          : returnedParent?.id !== parent.id ||
            returnedParent?.iid !== parent.iid
      ) throw new Error();
      return { project, item, parent: returnedParent };
    } catch {
      throw new Error(unknownMutationOutcome);
    }
  }

  /** Read successive issue, task or incident pages up to the explicit request limit. */
  async list(args: GitLabListArguments): Promise<GitLabListResult> {
    const project = projectPath(args.project);
    let page = positiveInteger(args.page);
    const perPage = boundedInteger(args.perPage, 100);
    const maxPages = boundedInteger(args.maxPages, 100);
    const labels = args.labels === undefined ? [] : labelNames(args.labels);
    if (
      !["all", "issue", "task", "incident"].includes(args.type) ||
      !["all", "opened", "closed"].includes(args.state)
    ) {
      throw new Error("Unsupported GitLab work-item filter.");
    }
    const items: GitLabWorkItem[] = [];
    const seen = new Set<number>();
    for (let pagesFetched = 1; pagesFetched <= maxPages; pagesFetched++) {
      const url = new URL(
        `/api/v4/projects/${encodeURIComponent(project)}/issues`,
        this.origin,
      );
      url.search = new URLSearchParams({
        scope: "all",
        state: args.state,
        page: String(page),
        per_page: String(perPage),
        order_by: "created_at",
        sort: "asc",
        ...(args.type === "all" ? {} : { issue_type: args.type }),
        ...(labels.length === 0 ? {} : { labels: labels.join(",") }),
      }).toString();
      const { response, data } = await this.request(url);
      if (!Array.isArray(data) || data.length > perPage) {
        throw new Error("GitLab returned an invalid work-item page.");
      }
      for (const raw of data) {
        const item = workItem(raw);
        if (seen.has(item.id)) {
          throw new Error("GitLab repeated a work item while paginating.");
        }
        if (args.type !== "all" && item.type !== args.type) {
          throw new Error(
            "GitLab returned a work item outside the requested type.",
          );
        }
        seen.add(item.id);
        items.push(item);
      }
      const header = response.headers.get("x-next-page");
      if (header === null && data.length === perPage) {
        throw new Error("GitLab omitted pagination metadata for a full page.");
      }
      const nextPage = header === null || header === ""
        ? null
        : positiveInteger(header);
      if (nextPage !== null && (nextPage !== page + 1 || data.length === 0)) {
        throw new Error("GitLab returned invalid page progression.");
      }
      if (nextPage === null || pagesFetched === maxPages) {
        return {
          project,
          items,
          pagination: { complete: nextPage === null, nextPage, pagesFetched },
        };
      }
      page = nextPage;
    }
    throw new Error("GitLab pagination did not complete.");
  }

  /** Read a full work-item description and, when requested, its hierarchy. */
  async get(args: GitLabGetArguments): Promise<GitLabGetResult> {
    const project = projectPath(args.project);
    const iid = positiveInteger(args.iid);
    const perPage = boundedInteger(args.perPage, 100);
    const maxPages = boundedInteger(args.maxPages, 100);
    if (typeof args.includeHierarchy !== "boolean") {
      throw new Error("includeHierarchy must be a boolean.");
    }
    if (
      args.after !== undefined &&
      (typeof args.after !== "string" || !args.after)
    ) {
      throw new Error("Hierarchy cursor must be a non-empty string.");
    }
    const item = await this.readItem(project, iid);
    const hierarchy = args.includeHierarchy
      ? await this.getHierarchy(project, item, perPage, maxPages, args.after)
      : { status: "not-requested" } as const;
    return { project, item, hierarchy };
  }

  private async getHierarchy(
    project: string,
    item: GitLabWorkItem,
    first: number,
    maxPages: number,
    initialCursor?: string,
  ): Promise<GitLabHierarchy> {
    let after: string | null = initialCursor ?? null;
    let parent: GitLabWorkItemReference | null = null;
    let priorParentId: number | null | undefined;
    const children: GitLabWorkItemReference[] = [];
    const seenChildren = new Set<number>();
    const seenCursors = new Set<string>(initialCursor ? [initialCursor] : []);
    for (let pagesFetched = 1; pagesFetched <= maxPages; pagesFetched++) {
      const { data } = await this.request(
        new URL("/api/graphql", this.origin),
        {
          query: hierarchyQuery,
          variables: { project, iid: String(item.iid), first, after },
        },
      );
      const envelope = record(data);
      if (
        envelope.errors !== undefined &&
        (!Array.isArray(envelope.errors) || envelope.errors.length > 0)
      ) {
        throw new Error(
          "GitLab GraphQL returned errors; hierarchy is incomplete.",
        );
      }
      const connection = record(
        record(record(envelope.data).project).workItems,
      );
      if (!Array.isArray(connection.nodes) || connection.nodes.length !== 1) {
        throw new Error("GitLab did not return the requested hierarchy root.");
      }
      const root = record(connection.nodes[0]);
      const rootReference = reference(root);
      if (rootReference.iid !== item.iid || rootReference.id !== item.id) {
        throw new Error("GitLab returned a different hierarchy root.");
      }
      if (root.widgets === null || root.widgets === undefined) {
        return {
          status: "unavailable",
          reason: "GitLab did not expose the hierarchy widget.",
        };
      }
      if (!Array.isArray(root.widgets)) {
        throw new Error("GitLab returned invalid work-item widgets.");
      }
      const widgets = root.widgets.map(record).filter((widget) =>
        widget.type === "HIERARCHY"
      );
      if (widgets.length === 0) {
        return {
          status: "unavailable",
          reason: "GitLab did not expose the hierarchy widget.",
        };
      }
      if (widgets.length !== 1) {
        throw new Error("GitLab returned duplicate hierarchy widgets.");
      }
      const widget = widgets[0];
      if (
        !("parent" in widget) || widget.children === null ||
        widget.children === undefined
      ) {
        return {
          status: "unavailable",
          reason: "GitLab did not expose the complete hierarchy widget.",
        };
      }
      const currentParent = widget.parent === null
        ? null
        : reference(widget.parent);
      if (pagesFetched > 1 && (currentParent?.id ?? null) !== priorParentId) {
        throw new Error("GitLab hierarchy changed while paginating.");
      }
      parent = currentParent;
      priorParentId = currentParent?.id ?? null;
      const childConnection = record(widget.children);
      if (
        !Array.isArray(childConnection.nodes) ||
        childConnection.nodes.length > first
      ) {
        throw new Error("GitLab returned an invalid hierarchy page.");
      }
      for (const node of childConnection.nodes) {
        const child = reference(node);
        if (seenChildren.has(child.id)) {
          throw new Error("GitLab repeated a child while paginating.");
        }
        seenChildren.add(child.id);
        children.push(child);
      }
      const pageInfo = record(childConnection.pageInfo);
      if (
        typeof pageInfo.hasNextPage !== "boolean" ||
        (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== "string")
      ) {
        throw new Error(
          "GitLab returned invalid hierarchy pagination metadata.",
        );
      }
      const nextCursor = pageInfo.hasNextPage
        ? pageInfo.endCursor as string
        : null;
      if (
        pageInfo.hasNextPage &&
        (!nextCursor || seenCursors.has(nextCursor) ||
          childConnection.nodes.length === 0)
      ) {
        throw new Error(
          "GitLab returned invalid hierarchy cursor progression.",
        );
      }
      if (!pageInfo.hasNextPage || pagesFetched === maxPages) {
        return {
          status: "available",
          parent,
          children,
          complete: !pageInfo.hasNextPage,
          nextCursor,
          pagesFetched,
        };
      }
      seenCursors.add(nextCursor!);
      after = nextCursor;
    }
    throw new Error("GitLab hierarchy pagination did not complete.");
  }
}

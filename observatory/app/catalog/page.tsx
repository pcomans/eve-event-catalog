import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { eventTypes, type EventType } from "@/lib/catalog-definition";
import { summarizeParamsSchema } from "@/lib/catalog-params-summary";
import { cn } from "@/lib/utils";

// task #34 — the Catalog page. This is the product pitch: what an agent can
// subscribe to, not what's currently subscribed (that's Subscriptions, the
// next page over). No polling, no "use client" — catalog.json is baked
// into this service's own build (lib/catalog-definition.ts), so this page
// is a plain Server Component: it renders once, correctly, with nothing to
// load.

function EventStatusBadge({ status }: { status: EventType["status"] }) {
  if (status === "active") {
    return (
      <Badge variant="outline" className="bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-400">
        Active
      </Badge>
    );
  }
  // "planned" per catalog/types.ts: declared in catalog.json (schema and
  // all) but no provider registered yet — assertCatalogHonesty (catalog.ts)
  // is what keeps this distinction truthful: an "active" entry with no
  // handler fails the boot, so this badge is never lying about a planned
  // entry actually working.
  return (
    <Badge variant="outline" className="border-dashed text-muted-foreground">
      Planned
    </Badge>
  );
}

function ParamsSummary({ params }: { params: EventType["params"] }) {
  const fields = summarizeParamsSchema(params);
  // p6k gate (MED): `null` (schema itself unusable) is a genuinely
  // different, worse case than `[]` (a valid schema that legitimately
  // declares zero properties, e.g. alpaca order.filled) — see
  // summarizeParamsSchema's own doc comment. Rendering both the same way
  // would quietly hide a malformed catalog.json entry behind the same
  // "No parameters" message a perfectly healthy one also shows.
  if (fields === null) {
    return <p className="text-xs text-destructive">Params schema unavailable.</p>;
  }
  if (fields.length === 0) {
    return <p className="text-xs text-muted-foreground">No parameters. Subscribe with an empty params object.</p>;
  }
  return (
    <dl className="space-y-2">
      {fields.map((field) => (
        <div key={field.name}>
          <dt className="font-mono text-xs font-medium">
            {field.name}
            <span className="ml-1.5 font-sans text-muted-foreground">
              {field.type} · {field.required ? "required" : "optional"}
            </span>
          </dt>
          {field.description && <dd className="mt-0.5 text-xs text-muted-foreground">{field.description}</dd>}
        </div>
      ))}
    </dl>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function EventTypeCard({ eventType }: { eventType: EventType }) {
  const isActive = eventType.status === "active";
  return (
    <div className={cn("rounded-md border p-4", !isActive && "border-dashed bg-muted/20")}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">
            {eventType.provider} · {eventType.event}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{eventType.description}</p>
        </div>
        <EventStatusBadge status={eventType.status} />
      </div>

      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        <div>
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Params</h3>
          <div className="mt-2">
            <ParamsSummary params={eventType.params} />
          </div>
        </div>
        <div>
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Metadata</h3>
          <dl className="mt-2 space-y-1.5">
            <MetadataRow label="Freshness" value={eventType.metadata.freshness} />
            <MetadataRow label="Latency" value={eventType.metadata.latency} />
            <MetadataRow label="Auth" value={eventType.metadata.auth} />
            <MetadataRow label="Cost" value={eventType.metadata.cost} />
            <MetadataRow label="Durability" value={eventType.metadata.durability} />
          </dl>
        </div>
      </div>

      {eventType.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1">
          {eventType.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[10px]">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      <Collapsible className="mt-4">
        <CollapsibleTrigger className="text-xs font-medium text-muted-foreground hover:text-foreground">
          Wake instructions
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 rounded-md bg-muted/30 p-3 text-xs whitespace-pre-wrap text-muted-foreground">
          {eventType.onWake}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export default function CatalogPage() {
  return (
    <div className="p-6">
      <h1 className="mb-1 text-lg font-semibold">Catalog</h1>
      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
        Every event type this catalog knows how to watch and wake an agent for. This is what&apos;s on offer. For
        what&apos;s actually been subscribed to, see Subscriptions.
      </p>
      <div className="grid gap-4">
        {eventTypes.map((eventType) => (
          <EventTypeCard key={`${eventType.provider}:${eventType.event}`} eventType={eventType} />
        ))}
      </div>
    </div>
  );
}

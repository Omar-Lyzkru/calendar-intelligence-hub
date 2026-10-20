import { type z } from "zod";
import { DiscordMessagePageSchema, safeMessage } from "@hub/contracts";
export function DiscordMessages({
  page,
  onOpen,
  onNext,
}: {
  page: z.infer<typeof DiscordMessagePageSchema>;
  onOpen: (id: string) => void;
  onNext: () => void;
}) {
  return (
    <section className="card">
      <h2>Discord announcements</h2>
      <p className="hint">
        Follow announcements from your configured feed are imported
        automatically while the backend is running. Calendar events still
        require your approval.
      </p>
      {!page.items.length && (
        <p>
          No imported Discord announcements yet. Manual channel posts are
          excluded from the automatic feed.
        </p>
      )}
      {page.items.map((item) => (
        <div className="connection" key={item.id}>
          <h3>{item.title || "Untitled candidate"}</h3>
          <p>
            {item.status === "review"
              ? "Candidate available for review"
              : "Processed without an event candidate"}
            . Received: {item.receivedAt}
          </p>
          {item.reviewId && (
            <button className="quiet" onClick={() => onOpen(item.reviewId!)}>
              Review {item.title || "Untitled candidate"}
            </button>
          )}
        </div>
      ))}
      {page.failures.map((item) => (
        <p className="notice" key={item.id}>
          Announcement could not be processed: {safeMessage(item.reason)}
        </p>
      ))}
      {page.nextPageToken && (
        <button className="secondary" onClick={onNext}>
          Next announcement page
        </button>
      )}
    </section>
  );
}

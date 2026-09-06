import React from "react";

export function WorkspacePreview() {
  return (
    <div className="identity-preview" aria-hidden="true">
      <aside><span /><span /><span /><span /></aside>
      <section>
        <header><i /><i /></header>
        <div className="identity-preview__metrics"><i /><i /><i /><i /></div>
        <div className="identity-preview__grid"><i /><i /><i /></div>
      </section>
    </div>
  );
}

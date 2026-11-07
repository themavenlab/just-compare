# Publishing the source later

The application retains MIT OR Apache-2.0 now; its source repository is private.
Not publishing source is different from proprietary licensing. Keep existing
license texts and third-party obligations in distributed builds. Public source
publication needs separate owner approval, not an automatic license change.

## Before changing visibility

1. Confirm ownership and contribution rights, original fixtures/artwork and
   dependency license/source obligations. Brand assets need their own rights
   review; do not assume app licensing covers every marketing asset.
2. Review the entire history, tags, branches, issues, CI logs and artifacts for
   credentials, personal paths/data, proprietary references and unlicensed
   fixtures. Rotate exposed secrets; deleting the latest file is insufficient.
   Obtain explicit approval for any history rewriting or destructive cleanup.
3. Review repository metadata and links. Select the intended public repository
   and visibility; repository creation, migration and pushes need approval.
4. Validate a clean checkout build with pinned dependencies and documented
   native prerequisites. Review CI permissions, secret use, artifacts and
   contribution-triggered workflows before accepting untrusted submissions.
5. Establish public issue/contribution guidelines and a real private security
   reporting route. Do not invent contacts or enable broken support links.
6. Preserve the root MIT/Apache files, manifest declarations, attribution and
   distribution notices. Review any ownership/license changes separately.

## Update together when publication actually happens

- README, documentation index, product scope and contribution guide: replace
  private-source status with truthful public-source information.
- Website product configuration/footer: enable the verified source URL and
  contribution links; introduce open-source messaging only when accessible.
- Store description and support links: update source availability without
  changing claims about implemented features or compatibility.
- Release/dependency guides: document public covered-source availability and
  verify shipped notices still satisfy obligations.
- Project badges, repository links and support/security routing: verify public
  access from a signed-out session.

Publish only the reviewed repository/materials. A public website does not
authorize app-source publication, and source publication does not authorize
Store releases or changes to third-party licenses.

# Student portfolio

Every student may have one private portfolio containing intentionally selected projects. Portfolio items capture a short description, reflection, learning, normalized skills, technologies, demo reference, private cover/media paths, and completion date.

Privacy rules:

- default visibility is `private`;
- no anonymous/public RLS policy exists;
- only the owner, assigned teacher, or administrator can read the portfolio;
- raw homework, grades, attendance, teacher feedback, auth data, Telegram IDs, email, phone, and internal identifiers are never showcase data;
- future sharing requires an explicit `shared` state and a securely generated token hash. A public endpoint is not part of this phase.

`skills`, `project_skills`, and `student_skills` are reusable and data-driven. Technologies remain project evidence rather than a fixed taxonomy.

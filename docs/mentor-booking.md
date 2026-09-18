# Mentor 1:1 booking

Mentors are not hardcoded to one person. `mentor_availability` stores explicit timezone-aware windows. Bookings store student, mentor, range, timezone, provider-neutral HTTPS meeting URL, status, and reschedule origin.

Statuses: `reserved`, `confirmed`, `completed`, `cancelled`, `rescheduled`, `no_show`.

Two PostgreSQL exclusion constraints prevent overlapping active bookings for both mentor and student. `book_mentor_slot` locks the availability row, verifies the active mentor assignment, enforces the mentor's weekly limit, marks the slot booked, and creates the reservation in one transaction. A race returns conflict instead of creating a double booking. Mentor profiles define default slot length and a data-driven cancellation policy; blocked windows use the availability status.

The Student App exposes “Допомога ментора” and “Забронювати зустріч”. Cancellation policy, blocked/recurring windows, reminders, and meeting-link assignment remain server concerns.

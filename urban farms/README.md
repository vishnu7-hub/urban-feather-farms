# Urban Farms

Farm ordering website with customer ordering, worker delivery proof, and an admin dashboard.

## Run locally

1. Install Node.js 18 or later.
2. In this folder, run `npm install`.
3. Copy `.env.example` to `.env` and set a strong `JWT_SECRET`, admin password, and bypass code.
4. Run `npm test`, then `npm start` and open `http://localhost:3000`.

The site stores its local demo data in `data/`. Do not deploy the JSON files as a production database. Online payments and SMS OTP delivery require their own provider integrations before they can be enabled for customers.

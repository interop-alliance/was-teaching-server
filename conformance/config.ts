const { TEST_SERVER_URL, TEST_ONBOARDING_TOKEN } = process.env
const onboardingToken: string | null = TEST_ONBOARDING_TOKEN ?? null

if (!TEST_SERVER_URL) {
  console.error('Error: TEST_SERVER_URL environment variable is required.')
  console.error(
    'Usage: TEST_SERVER_URL=https://was.example.com npm run conformance'
  )
  process.exit(1)
}

const serverUrl: string = TEST_SERVER_URL

export { serverUrl, onboardingToken }

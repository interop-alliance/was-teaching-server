const { TEST_SERVER_URL: serverUrl, TEST_ONBOARDING_TOKEN: onboardingToken = null } = process.env

if (!serverUrl) {
  console.error('Error: TEST_SERVER_URL environment variable is required.')
  console.error('Usage: TEST_SERVER_URL=https://was.example.com npm run conformance')
  process.exit(1)
}

export { serverUrl, onboardingToken }
